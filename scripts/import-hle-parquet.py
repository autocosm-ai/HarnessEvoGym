#!/usr/bin/env python3
"""把明确来源的 HLE Parquet 转成文本数学题；不把镜像标成官方固定版本。"""
import argparse
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as pq


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    fields = ["id", "question", "answer", "answer_type", "raw_subject", "category", "image"]
    table = pq.read_table(source, columns=fields)
    rows = []
    seen = set()
    for row in table.to_pylist():
        if str(row["category"]).strip().lower() != "math" or row["image"] not in (None, ""):
            continue
        if row["id"] in seen:
            raise ValueError("HLE 包含重复题目 ID")
        if any(not isinstance(row[key], str) or not row[key].strip() for key in ["id", "question", "answer", "answer_type"]):
            raise ValueError("HLE 题目缺少必要字段")
        seen.add(row["id"])
        rows.append({key: value for key, value in row.items() if key != "image"})
    if not rows:
        raise ValueError("没有可用文本数学题")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    output.chmod(0o600)
    evidence = {"source": args.source, "revision": args.revision,
                "source_sha256": hashlib.file_digest(source.open("rb"), "sha256").hexdigest(),
                "eligible_sha256": hashlib.file_digest(output.open("rb"), "sha256").hexdigest(),
                "total_rows": table.num_rows, "text_math_rows": len(rows),
                "official_pinned_revision_verified": False}
    with output.with_suffix(".provenance.json").open("x", encoding="utf8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == "__main__":
    main()
