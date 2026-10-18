import { ProxyAgent, fetch as undiciFetch } from "undici";

/** Explicit process transport. Never put proxy credentials/URLs in run evidence. */
export function createBenchmarkTransport(env: NodeJS.ProcessEnv = process.env) {
  const proxy = env.BENCHMARK_HTTP_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY;
  if (!proxy)
    return { fetch: globalThis.fetch, mode: "direct", close: async () => {} };
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error("invalid_benchmark_http_proxy");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("invalid_benchmark_http_proxy");
  const agent = new ProxyAgent(proxy);
  const fetch = ((input, init) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher: agent } as unknown as Parameters<
        typeof undiciFetch
      >[1],
    )) as typeof globalThis.fetch;
  return {
    fetch,
    mode: "http-proxy",
    close: async () => {
      await agent.close();
    },
  };
}
