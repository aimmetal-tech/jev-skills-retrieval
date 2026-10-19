"""Render the published paired snapshot without accessing raw runs or services."""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "outputs/benchmark/cache/matplotlib"))

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402


def main():
    output = ROOT / "docs/benchmarks/2026-10-19-skillret-paused-212"
    payload = json.loads((output / "summary.json").read_text(encoding="utf-8"))
    paired = payload["groups"]
    complete = payload["completeUsageGroups"]
    n = payload["pairedQueries"]
    k = payload["completeUsagePairs"]
    names = ["Pi native", "Pi + Jev Skills Retrieval"]
    ticks = ["Pi native", "Pi + Jev\nSkills Retrieval"]
    colors = ["#4b6b87", "#d16a38"]
    plt.rcParams.update({"svg.hashsalt": "jev-skills-retrieval", "font.size": 10})
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), layout="constrained")
    fig.suptitle(
        "Jev Skills Retrieval — SkillRet paired comparison\n"
        "FROZEN PARTIAL RESULTS | Pi gpt-6-luna / medium | Jev 1.14.0",
        fontsize=15,
        weight="bold",
    )
    ax = axes[0, 0]
    for i, group in enumerate(paired):
        bars = ax.bar(
            [j + (i - 0.5) * 0.34 for j in range(3)],
            [100 * group[m] for m in ["readPrecision", "readRecall", "readF1"]],
            width=0.32,
            color=colors[i],
            label=names[i],
        )
        ax.bar_label(bars, fmt="%.1f%%", padding=3, fontsize=9)
    ax.set_xticks(range(3), ["Precision", "Recall", "F1"])
    ax.set_ylim(0, 100)
    ax.set_title(f"Read-set macro metrics | paired n={n}", loc="left")
    ax.legend(frameon=False, fontsize=9)
    ax = axes[0, 1]
    bars = ax.bar(
        ticks, [100 * g["successRate"] for g in paired], color=colors, width=0.55
    )
    ax.bar_label(
        bars,
        labels=[
            f"{g['successes']}/{n} ({100 * g['successRate']:.1f}%)" for g in paired
        ],
        padding=4,
    )
    ax.set_ylim(0, 100)
    ax.set_title(f"All labelled skills read | paired n={n}", loc="left")
    ax = axes[1, 0]
    for i, group in enumerate(complete):
        pi = group["piTokensKnown"] / k
        jev = group["jevTokensKnown"] / k
        ax.bar(i, pi, color=colors[0], width=0.55, label="Pi" if i == 0 else None)
        ax.bar(
            i,
            jev,
            bottom=pi,
            color=colors[1],
            width=0.55,
            label="Jev" if i == 0 else None,
        )
        ax.annotate(
            f"{(pi + jev) / 1e6:.2f}M",
            (i, pi + jev),
            xytext=(0, 5),
            textcoords="offset points",
            ha="center",
        )
    ax.set_xticks([0, 1], ticks)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value / 1e6:.1f}M"))
    ax.set_ylim(0, 3.3e6)
    ax.set_title(
        f"Tokens/query | complete-usage subset n={k} ONLY", loc="left", fontsize=10
    )
    ax.set_xlabel("Selected subset; cache counted once; not billed cost", fontsize=9)
    ax.legend(frameon=False)
    ax = axes[1, 1]
    bars = ax.bar(
        ticks, [g["meanLatencyMs"] / 1000 for g in paired], color=colors, width=0.55
    )
    ax.bar_label(
        bars, labels=[f"{g['meanLatencyMs'] / 1000:.2f}s" for g in paired], padding=4
    )
    ax.set_ylim(0, 180)
    ax.set_title(f"Mean online query time | paired n={n}", loc="left")
    ax.set_ylabel("Seconds")
    ax.set_xlabel("Includes queue/retry/recovery; not pure model latency", fontsize=9)
    for ax in axes.flat:
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", alpha=0.15)
        ax.set_axisbelow(True)
    fig.supxlabel(
        f"Stopped 2026-10-19 14:27:47 +08:00 | paired {n}/4392 (4.83%) | completed-only selection bias\n"
        "Main-sample token totals remain UNKNOWN | metadata adaptation, not official leaderboard or task success",
        fontsize=8,
    )
    fig.savefig(output / "comparison.png", dpi=170)
    fig.savefig(output / "comparison.svg", metadata={"Date": None})
    svg = output / "comparison.svg"
    content = svg.read_text(encoding="utf-8").replace(
        " <metadata>",
        " <title>Jev Skills Retrieval: 212 paired SkillRet queries; "
        "199 complete-usage pairs; frozen partial results</title>\n <metadata>",
        1,
    )
    svg.write_text(
        "\n".join(line.rstrip() for line in content.splitlines()) + "\n",
        encoding="utf-8",
    )
    plt.close(fig)
    print(output / "comparison.png")


if __name__ == "__main__":
    main()
