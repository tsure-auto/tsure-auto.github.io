#!/usr/bin/env python3
"""Build the static portfolio site without AWS or third-party Python packages."""

from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE_SOURCE = ROOT / "site"
POST_SOURCE = ROOT / "blog" / "posts"
DESTINATION = ROOT / "dist"


def parse_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{path} is missing YAML frontmatter")

    metadata: dict[str, object] = {}
    active_list: str | None = None

    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("  - ") and active_list:
            value = line[4:].strip().strip('"\'')
            values = metadata.setdefault(active_list, [])
            if isinstance(values, list):
                values.append(value)
            continue
        if ":" not in line:
            continue

        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            metadata[key] = value.strip('"\'')
            active_list = None
        else:
            metadata[key] = []
            active_list = key
    else:
        raise ValueError(f"{path} has unterminated YAML frontmatter")

    return metadata


def build() -> None:
    if DESTINATION.exists():
        shutil.rmtree(DESTINATION)
    shutil.copytree(SITE_SOURCE, DESTINATION)

    published_posts = DESTINATION / "blog" / "posts"
    published_posts.mkdir(parents=True, exist_ok=True)

    items = []
    seen_ids = set()
    for markdown_file in sorted(POST_SOURCE.glob("*.md")):
        metadata = parse_frontmatter(markdown_file)
        post_id = str(metadata.get("id", "")).strip()
        title = str(metadata.get("title", "")).strip()
        if not post_id or not title:
            raise ValueError(f"{markdown_file} requires id and title")
        if post_id in seen_ids:
            raise ValueError(f"Duplicate post id: {post_id}")
        seen_ids.add(post_id)

        destination_file = published_posts / markdown_file.name
        shutil.copy2(markdown_file, destination_file)
        items.append(
            {
                "post_id": post_id,
                "title": title,
                "published": str(metadata.get("published", "")),
                "excerpt": str(metadata.get("excerpt", "")),
                "tags": metadata.get("tags", []),
                "markdown_url": f"/blog/posts/{markdown_file.name}",
            }
        )

    items.sort(key=lambda post: str(post["published"]), reverse=True)
    (DESTINATION / "blog" / "posts.json").write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (DESTINATION / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Built {len(items)} posts into {DESTINATION}")


if __name__ == "__main__":
    build()
