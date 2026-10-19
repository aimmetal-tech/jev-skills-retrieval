"""Render measured results (or explicitly empty templates) to PNG, SVG and HTML."""

import html
import json
import os
import sys
from pathlib import Path

os.environ.setdefault(
    "MPLCONFIGDIR",
    str(Path(__file__).resolve().parent.parent / "outputs/benchmark/cache/matplotlib"),
)
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch


def render(output):
    output = Path(output)
    summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
    groups = summary["groups"]
    indexed = {(r["suite"], r["group"]): r for r in groups}
    colors = {"native": "#4b6b87", "router": "#d16a38"}
    evidence = summary["evidence"]
    title = {
        "live": "Measured benchmark results",
        "mock": "MOCK VALIDATION — not model performance",
    }.get(evidence, "NO LIVE RESULTS — report template")
    plt.rcParams.update(
        {"font.size": 10, "axes.spines.top": False, "axes.spines.right": False}
    )
    fig, axes = plt.subplots(2, 2, figsize=(13, 8), layout="constrained")
    fig.suptitle(f"Jev Skills Retrieval — {title}", fontsize=17, fontweight="bold")

    def bars(ax, suite, metric, caption, percent=False):
        for x, group in enumerate(("native", "router")):
            row = indexed[suite, group]
            value = row[metric]
            if value is None:
                ax.text(
                    x,
                    0.12,
                    "N/A",
                    ha="center",
                    transform=ax.get_xaxis_transform(),
                    color="#777777",
                )
            else:
                shown = value * 100 if percent else value
                container = ax.bar(x, shown, color=colors[group], width=0.58)
                ax.bar_label(
                    container,
                    labels=[f"{shown:.1f}%" if percent else f"{shown:,.0f}"],
                    padding=4,
                )
        ax.set_xticks([0, 1], ["Pi native", "Pi + Jev Skills Retrieval"])
        ax.set_title(caption, loc="left", fontweight="bold")
        ax.set_xlim(-0.6, 1.6)
        if percent:
            ax.set_ylim(0, 112)
        elif all(indexed[suite, g][metric] is None for g in ("native", "router")):
            ax.set_ylim(0, 1)
        else:
            ax.margins(y=0.2)
        coverage = " / ".join(
            f"{g}: n={indexed[suite, g]['attempted']}/{indexed[suite, g]['expected']}"
            for g in ("native", "router")
        )
        ax.set_xlabel(coverage, fontsize=8)

    bars(axes[0, 0], "skillret", "readF1", "SkillRet — successful-read F1", True)
    bars(
        axes[0, 1],
        "skillsbench",
        "successRate",
        "SkillsBench — verifier pass rate",
        True,
    )
    bars(
        axes[1, 0],
        "skillsbench",
        "tokensPerSuccess",
        "SkillsBench — total tokens / success",
    )
    ax = axes[1, 1]
    ax.set_title("Token usage — Pi + Jev", loc="left", fontweight="bold")
    labels = []
    for x, row in enumerate(groups):
        labels.append(f"{row['suite']}\n{row['group']}")
        if row["attempted"] == 0:
            ax.text(
                x,
                0.15,
                "N/A",
                ha="center",
                transform=ax.get_xaxis_transform(),
                fontsize=9,
            )
            continue
        ax.bar(x, row["piTokensKnown"], color="#4b6b87", label="Pi" if x == 0 else None)
        ax.bar(
            x,
            row["jevTokensKnown"],
            bottom=row["piTokensKnown"],
            color="#d16a38",
            label="Jev" if x == 0 else None,
        )
        if not row["usageComplete"]:
            ax.annotate(
                "known only",
                (x, row["piTokensKnown"] + row["jevTokensKnown"]),
                xytext=(0, 5),
                textcoords="offset points",
                ha="center",
                fontsize=8,
            )
    ax.set_xticks(range(len(groups)), labels, fontsize=8)
    ax.set_xlim(-0.6, len(groups) - 0.4)
    if not any(r["attempted"] for r in groups):
        ax.set_ylim(0, 1)
    else:
        ax.legend(
            handles=[
                Patch(color="#4b6b87", label="Pi"),
                Patch(color="#d16a38", label="Jev"),
            ],
            frameon=False,
        )
    ax.set_xlabel(
        "Unknown usage is not zero. Reasoning is an output subset.", fontsize=8
    )
    fig.savefig(output / "comparison.png", dpi=170)
    fig.savefig(output / "comparison.svg")
    plt.close(fig)

    columns = [
        ("suite", "Suite"),
        ("group", "Group"),
        ("attempted", "Attempted"),
        ("expected", "Expected"),
        ("readPrecision", "Read precision"),
        ("readRecall", "Read recall"),
        ("readF1", "Read F1"),
        ("routeF1", "Router F1"),
        ("successRate", "Success rate"),
        ("fallbacks", "Fallbacks"),
        ("tokensPerSuccess", "Tokens/success"),
        ("usageComplete", "Usage complete"),
    ]
    header = "".join(f"<th>{html.escape(label)}</th>" for _, label in columns)
    body = ""
    for row in groups:
        values = []
        for key, _ in columns:
            value = row[key]
            text = (
                "N/A"
                if value is None
                else f"{value:.4f}"
                if isinstance(value, float)
                else str(value)
            )
            values.append(f"<td>{html.escape(text)}</td>")
        body += "<tr>" + "".join(values) + "</tr>"
    notes = "".join(f"<li>{html.escape(note)}</li>" for note in summary["notes"])
    svg = (output / "comparison.svg").read_text(encoding="utf-8")
    svg = svg[svg.index("<svg") :]
    page = f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{html.escape(title)}</title><style>body{{font:15px system-ui;margin:32px auto;max-width:1320px;padding:0 24px;color:#17212a;background:#faf9f6}}h1{{font-size:28px}}svg{{width:100%;height:auto}}.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;background:white;font-size:12px}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #ddd}}a{{color:#285f85}}li{{margin:8px 0}}</style>
<h1>{html.escape(title)}</h1><p>Evidence: <strong>{html.escape(evidence)}</strong>. One repetition; incomplete coverage is not a full-suite result.</p>
{svg}<div class="scroll"><table><thead><tr>{header}</tr></thead><tbody>{body}</tbody></table></div>
<ul>{notes}</ul><p>SkillRet success means all labelled skills were read; SkillsBench success requires official verifier reward=1. These success definitions are reported separately.</p>
<p>Files: <a href="results.jsonl">trial evidence</a> · <a href="results.csv">CSV</a> · <a href="summary.json">summary</a> · <a href="run.json">run manifest</a> · <a href="comparison.png">PNG</a> · <a href="comparison.svg">SVG</a></p></html>"""
    (output / "report.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    render(sys.argv[1])
