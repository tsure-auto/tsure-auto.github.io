# Tim Surento Portfolio

Static portfolio and technical blog hosted on GitHub Pages.

## Add a post

1. Add a Markdown file to `blog/posts/`.
2. Include `id`, `title`, `published`, `excerpt`, and `tags` in its frontmatter.
3. Push the change to `main`.

GitHub Actions builds and deploys the site automatically. No AWS services or
application database are required.

## Build locally

```shell
python3 scripts/build_site.py
python3 -m http.server 8000 --directory dist
```
