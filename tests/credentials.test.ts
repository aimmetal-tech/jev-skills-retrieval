import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JevCredentials } from "../src/credentials.ts";
import { MaskedKeyInput } from "../src/key-prompt.ts";

function context(
  input: ExtensionUIContext["input"],
  options: { hasUI?: boolean; signal?: AbortSignal } = {},
) {
  const warnings: string[] = [];
  return {
    ctx: {
      ui: {
        input,
        notify: (message: string) => warnings.push(message),
      } as unknown as ExtensionUIContext,
      mode: "rpc",
      hasUI: options.hasUI ?? true,
      signal: options.signal,
    } satisfies Pick<ExtensionContext, "ui" | "mode" | "hasUI" | "signal">,
    warnings,
  };
}

test("credential input blocks until supplied, then reuses private memory without mutating environment", async () => {
  const originalEnvironment = process.env.TYPESAFE_API_KEY;
  let submit: (value: string) => void = () => {};
  let prompts = 0;
  const { ctx } = context(async () => {
    prompts++;
    return new Promise<string>((resolve) => {
      submit = resolve;
    });
  });
  const credentials = new JevCredentials(() => undefined);
  let settled = false;
  const pending = credentials.ensure(ctx).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(credentials.getApiKey(), undefined);
  submit("  test-session-key  ");
  assert.deepEqual(await pending, { status: "ready" });
  assert.equal(credentials.getApiKey(), "test-session-key");
  assert.deepEqual(await credentials.ensure(ctx), { status: "ready" });
  assert.equal(prompts, 1);
  assert.equal(process.env.TYPESAFE_API_KEY, originalEnvironment);
  credentials.clear();
  assert.equal(credentials.getApiKey(), undefined);
});

test("environment credentials take priority over temporary input without opening another dialog", async () => {
  let environment: string | undefined;
  let prompts = 0;
  const { ctx } = context(async () => {
    prompts++;
    return "temporary-key";
  });
  const credentials = new JevCredentials(() => environment);
  await credentials.ensure(ctx);
  environment = "  environment-key  ";
  await credentials.ensure(ctx);
  assert.equal(prompts, 1);
  assert.equal(credentials.getApiKey(), "environment-key");
});

test("empty and multiline credential input stays blocked and asks again", async () => {
  const answers = ["  ", "first\nsecond", "valid-test-key"];
  const { ctx, warnings } = context(async () => answers.shift());
  const credentials = new JevCredentials(() => undefined);
  assert.deepEqual(await credentials.ensure(ctx), { status: "ready" });
  assert.equal(credentials.getApiKey(), "valid-test-key");
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join(), /first|second|valid-test-key/);
});

test("cancelled input remains unset and a later request can prompt again", async () => {
  let attempts = 0;
  const { ctx } = context(async () =>
    ++attempts === 1 ? undefined : "retry-key",
  );
  const credentials = new JevCredentials(() => undefined);
  assert.deepEqual(await credentials.ensure(ctx), { status: "cancelled" });
  assert.equal(credentials.getApiKey(), undefined);
  assert.deepEqual(await credentials.ensure(ctx), { status: "ready" });
  assert.equal(credentials.getApiKey(), "retry-key");
});

test("headless and pre-aborted operations never open a dialog", async () => {
  const credentials = new JevCredentials(() => undefined);
  const unexpected = async () => {
    throw new Error("Must not prompt");
  };
  assert.deepEqual(
    await credentials.ensure(context(unexpected, { hasUI: false }).ctx),
    { status: "unavailable" },
  );
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await credentials.ensure(
      context(unexpected, { signal: controller.signal }).ctx,
    ),
    { status: "aborted" },
  );
});

test("dialog errors never expose entered credential text", async () => {
  const { ctx, warnings } = context(async () => {
    throw new Error("sensitive-test-key");
  });
  const credentials = new JevCredentials(() => undefined);
  const result = await credentials.ensure(ctx);
  assert.deepEqual(result, { status: "ui_error" });
  assert.doesNotMatch(
    JSON.stringify({ result, warnings }),
    /sensitive-test-key/,
  );
});

test("TUI masks typed and pasted keys at all widths while submitting the original value", () => {
  const input = new MaskedKeyInput();
  input.focused = true;
  input.handleInput("\x1b[200~test-secret-for-ui\x1b[201~");
  const value = input.getValue();
  assert.equal(value, "test-secret-for-ui");
  for (const width of [0, 1, 8, 40, 100]) {
    const lines = input.render(width);
    assert.doesNotMatch(lines.join("\n"), /test-secret-for-ui/);
    assert(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(input.getValue(), value);
  }
  let submitted: string | undefined;
  input.onSubmit = (key) => {
    submitted = key;
  };
  input.handleInput("\r");
  assert.equal(submitted, value);
  input.dispose();
  assert.equal(input.getValue(), "");
});

test("explicit key configuration replaces private memory, preserves it on cancellation and respects environment priority", async () => {
  let environment: string | undefined;
  const answers = ["first-key", undefined, "second-key", "third-key"];
  const { ctx } = context(async () => answers.shift());
  const credentials = new JevCredentials(() => environment);
  assert.equal(credentials.getSource(), "missing");
  await credentials.configure(ctx);
  assert.equal(credentials.getSource(), "memory");
  assert.equal(credentials.getApiKey(), "first-key");
  assert.deepEqual(await credentials.configure(ctx), { status: "cancelled" });
  assert.equal(credentials.getApiKey(), "first-key");
  await credentials.configure(ctx);
  assert.equal(credentials.getApiKey(), "second-key");
  environment = "environment-key";
  await credentials.configure(ctx);
  assert.equal(credentials.getSource(), "environment");
  assert.equal(credentials.getApiKey(), "environment-key");
  environment = undefined;
  assert.equal(credentials.getApiKey(), "third-key");
});
