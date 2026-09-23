---
id: infrastructure-overview
title: How the Previous AWS Version of This Site Was Built
published: 2026-01-14
excerpt: A practical walkthrough of the former AWS, Terraform, and Bitbucket architecture used for this portfolio and API-backed blog
tags:
  - python
  - website
  - aws
  - terraform
---

# Overview

> **Historical architecture:** This article documents the original AWS-hosted version of this portfolio. The current site is statically generated and hosted on GitHub Pages.

This post is a *walkthrough* of how my portfolio site (and API-backed blog) is built and deployed.

The sections below will cover the following topics:

- How the static site is hosted and served
- How the blog API works (Lambda + API Gateway + DynamoDB)
- How deployments happen from Bitbucket Pipelines
- How secrets and admin actions are handled safely

---

## High-Level Architecture

**Request flow (static + API):**

1. Visitor hits the site URL
2. **CloudFront** serves static assets from **S3** (private bucket via OAC)
3. Blog pages call an **API Gateway HTTP API**
4. API Gateway invokes a **Lambda** function
5. Lambda reads/writes blog posts in **DynamoDB**
6. Admin actions (create/update/delete) require an **admin token** stored in **SSM Parameter Store**

**Core AWS services:**
- S3 (static site assets)
- CloudFront (CDN + TLS + caching)
- Lambda (blog API)
- API Gateway (HTTP API)
- DynamoDB (posts table)
- SSM Parameter Store (admin token)
- IAM (least-privilege roles for CI + Lambda)

---

## Repo Layout

At a high level:

- `index.html`, `blog/`, `assets/` → frontend
- `api/app.py` → Lambda handler (blog API)
- `infra/` → Terraform (bootstrap + environment deployment)
- `bitbucket-pipelines.yml` + `deploy_site.sh` → CI/CD

---

## Frontend

The frontend is a static site (HTML/CSS/JS). It’s deployed into an S3 bucket and served through CloudFront.

Why CloudFront?
- HTTPS by default
- CDN caching (fast globally)
- origin protection via OAC (bucket stays private)
- ability to add routing/rewrite behavior for “pretty URLs” (blog posts, etc.)

---

## Backend API

The blog API is Lambda that supports:

- `GET /api/posts` → list posts (metadata)
- `GET /api/posts/{post_id}` → retrieve full post
- `POST /api/posts` → create/update (admin token required)
- `DELETE /api/posts/{post_id}` → delete (admin token required)
- `GET /health` → health check

---

## Blog Posts

Posts are stored in DynamoDB. The partition key is `post_id`.

A post item looks like:
- `post_id` (PK)
- `title`
- `created_at` (ISO timestamp)
- `content` (full HTML or markdown-rendered HTML)

Listing `/api/posts` returns a lightweight scan (title + timestamps) so the blog grid can render quickly.

---

## Infrastructure as Code

Everything is built with Terraform.

There are two main Terraform areas:

- `infra/bootstrap/` → one-time bootstrapping (state bucket, locking table, etc.)
- `infra/envs/prod/` → the actual site + API infrastructure

### Bootstrap Terraform: `infra/bootstrap/main.tf`

This is the “foundation” layer: remote state storage and locking so Terraform runs safely in CI.

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}



data "aws_caller_identity" "current" {}


resource "aws_s3_bucket" "tf_state" {
  bucket = "${var.project_name}-terraform-state-${data.aws_caller_identity.current.account_id}"

  force_destroy = false
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}





resource "aws_dynamodb_table" "tf_lock" {
  name         = "${var.project_name}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

**Why this matters:** remote state + locking prevents corrupt state and makes CI deployments reliable.

---

### Environment Terraform: `infra/envs/prod/main.tf` (selected excerpts)

This file is longer, so I’m including a few representative pieces.

#### Provider + tagging + site bucket setup

```hcl
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = var.project_name
      Env     = var.env_name
      Managed = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  site_bucket_name = "${var.project_name}-${var.site_name}-${data.aws_caller_identity.current.account_id}"
  api_source_dir   = "${path.module}/../../../api"
}

# -------------------------
# Static site (S3 + CloudFront)
# -------------------------

resource "aws_s3_bucket" "site" {
  bucket = local.site_bucket_name
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${var.project_name}-${var.env_name}-oac"
  description                       = "OAC for private S3 origin"
  origin_access_control_origin_type = "s3"
  signing_behavior
```

Key ideas:
- consistent tags for everything
- S3 bucket is private (no public ACL/policy)
- CloudFront is the public edge, not the bucket

#### CloudFront distribution (excerpt)

```hcl
principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_bucket_policy.json
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  is_ipv6_enabled     = false

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-site-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_clo
```

This is where the site becomes “real”:
- CloudFront points to S3 (origin)
- OAC is used so CloudFront can access the private bucket
- caching policies control performance and invalidation strategy

---

### CloudFront rewrite function: `infra/envs/prod/cloudfront_rewrite.tf`

This handles routing behavior (examples: `/blog/my-post` resolving correctly, SPA-ish routing rules, etc.)

```hcl
resource "aws_cloudfront_function" "rewrite" {
  name    = "portfolio-prod-rewrite"
  runtime = "cloudfront-js-1.0"
  comment = "Rewrite clean URLs for static site + blog post routing"
  publish = true

  code = <<EOT
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Normalize /blog -> /blog/
  if (uri === "/blog") {
    request.uri = "/blog/index.html";
    return request;
  }

  // /blog/ -> /blog/index.html
  if (uri === "/blog/") {
    request.uri = "/blog/index.html";
    return request;
  }

  // If requesting a folder like /foo/ -> /foo/index.html
  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
    return request;
  }

  // If the request already has an extension (.html, .css, .js, .png, etc.), leave it alone
  if (uri.indexOf(".") !== -1) {
    return request;
  }

  // Blog post clean URL:
  // /blog/hello-world  ->  /blog/post.html?id=hello-world
  if (uri.startsWith("/blog/")) {
    var slug = uri.substring("/blog/".length);

    // If someone hits /blog/post.html (without query) let it pass through (post.html handles missing id)
    if (slug === "post.html") {
      request.uri = "/blog/post.html";
      return request;
    }

    request.uri = "/blog/post.html";

    // Add/overwrite querystring id=<slug>
    request.querystring = request.querystring || {};
    request.querystring["id"] = { value: slug };

    return request;
  }

  // Default: treat clean paths as pages
  // /about -> /about.html
  request.uri = uri + ".html";
  return request;
}
EOT
}
```

---

## CI/CD Pipeline

Deployments are run by **Bitbucket Pipelines**.

High-level flow:
1. assume AWS permissions using Bitbucket **OIDC** (no stored AWS keys)
2. run `terraform init/plan/apply` in the environment folder
3. deploy the static site to S3
4. invalidate CloudFront so changes show quickly

### `bitbucket-pipelines.yml` (selected excerpts)

The most important bit is the OIDC-based role assumption:

```yaml
image: hashicorp/terraform:1.7.5

pipelines:
  pull-requests:
    "**":
      - step:
          name: Terraform fmt + plan (PR)
          oidc: true
          script:
            - apk add --no-cache aws-cli bash

            # Assume AWS Terraform role (OIDC)
            - export AWS_ROLE_ARN="<AWS_ROLE_ARN>"
            - export AWS_WEB_IDENTITY_TOKEN_FILE="$(pwd)/web-identity-token"
            - echo "$BITBUCKET_STEP_OIDC_TOKEN" > "$AWS_WEB_IDENTITY_TOKEN_FILE"
            - export AWS_DEFAULT_REGION="us-east-1"
            - aws sts get-caller-identity

            # Terraform checks
            - cd infra/envs/prod
            - terraform init -input=false
            - terraform fmt -check
            - terraform plan -input=false

  branches:
    main:
      - step:
          name: Terraform apply + Publish blog + Deploy static site (main)
          oidc: true
          script:
            - apk add --no-cache aws-cli bash python3 py3-pip

            # Assume AWS Terraform role (OIDC)
            - export AWS_ROLE_ARN="<AWS_ROLE_ARN>"
            - export AWS_WEB_IDENTITY_TOKEN_FILE="$(pwd)/web-identity-token"
            - echo "$BITBUCKET_STEP_OIDC_TOKEN" > "$AWS_WEB_IDENTITY_TOKEN_FILE"
            - export AWS_DEFAULT_REGION="us-east-1"
            - aws sts get-caller-identity

            # Apply infra
            - cd infra/envs/prod
            - terraform init -input=false
            - terraform apply -auto-approve -input=false

            # Everything below needs to run after terraform apply while we still have context
            - |
              API_BASE_URL="$(terraform output -raw api_base_url)"
              cd ../../..

              # ---- generate frontend config.json from Terraform output ----
              cat > site/config.json <<EOF
              {
                "apiBaseUrl": "${API_BASE_URL}"
              }
              EOF

              echo "Generated site/config.json:"
              cat site/config.json
              # --------------------------------------------------------------------

              # ---- publish markdown posts to API (Git-backed content) -------
              export API_BASE_URL="${API_BASE_URL}"

              # Pull admin token from SSM (strip CR + trim whitespace)
              export ADMIN_TOKEN="$(aws ssm get-parameter \
                --name /portfolio/prod/admin_token \
                --with-decryption \
                --query Parameter.Value \
                --output text | tr -d '\r' | xargs)"

              echo "Publishing blog posts via API_BASE_URL=$API_BASE_URL"
              echo "ADMIN_TOKEN length: ${#ADMIN_TOKEN}"

              python3 - <<'PY'
              import os, hashlib
              t = os.environ.get("ADMIN_TOKEN","").encode("utf-8")
              print("ADMIN_TOKEN sha256:", hashlib.sha256(t).hexdigest())
              PY

              # Create venv + install deps BEFORE any python that imports requests/markdown
              python3 -m venv .venv
              . .venv/bin/activate
              pip install --no-cache-dir requests markdown

              # quick API auth smoke test
              python - <<'PY'
              import os, requests
              base = os.environ["API_BASE_URL"].rstrip("/")
              tok = os.environ.get("ADMIN_TOKEN","")
              url = f"{base}/api/posts"
              r = requests.get(url, headers={"x-admin-token": tok}, timeout=20)
              print("Smoke test GET /api/posts ->", r.status_code)
              print((r.text or "")[:400])
              PY

              # Publish posts + prune missing (git-backed truth)
              export PRUNE_MISSING="true"
              # export PRUNE_DRY_RUN="true"   # first run: preview deletes safely

              python scripts/publish_posts.py
              # --------------------------------------------------------------------

            # Deploy static site (switch to least-privilege deploy role)
            - export AWS_ROLE_ARN="<AWS_ROLE_ARN>"
            - echo "$BITBUCKET_STEP_OIDC_TOKEN" > "$AWS_WEB_IDENTITY_TOKEN_FILE"
            - aws sts get-caller-identity
            - aws s3 sync site "s3://portfolio-portfolio-site-044079590345" --delete --exact-timestamps --cache-control "max-age=300"
# ...
```

And the deployment step triggers the site sync script:

```yaml
image: hashicorp/terraform:1.7.5

pipelines:
  pull-requests:
    "**":
      - step:
          name: Terraform fmt + plan (PR)
          oidc: true
          script:
            - apk add --no-cache aws-cli bash

            # Assume AWS Terraform role (OIDC)
            - export AWS_ROLE_ARN="<AWS_ROLE_ARN>"
            - export AWS_WEB_IDENTITY_TOKEN_FILE="$(pwd)/web-identity-token"
            - echo "$BITBUCKET_STEP_OIDC_TOKEN" > "$AWS_WEB_IDENTITY_TOKEN_FILE"
            - export AWS_DEFAULT_REGION="us-east-1"
            - aws sts get-caller-identity

            # Terraform checks
            - cd infra/envs/prod
            - terraform init -input=false
            - terraform fmt -check
            - terraform plan -input=false

  br
```

> Notes:
> - This pipeline does **not** store AWS access keys.
> - It uses Bitbucket's OIDC token to assume an IAM role in AWS.

---

### `deploy_site.sh`

This script is intentionally small:
- sync site content to the S3 bucket
- invalidate CloudFront paths so the latest content is served

```bash
#!/usr/bin/env bash
set -euo pipefail

BUCKET="portfolio-portfolio-site-{role_iam_value}"

aws s3 sync site "s3://${BUCKET}" \
  --delete \
  --exact-timestamps \
  --cache-control "max-age=300"

echo "Deployed to s3://${BUCKET}"
```

---

## API Implementation

The API is a plain Lambda handler. It reads method/path from the API Gateway event and routes accordingly.

### Admin token handling + request auth (`api/app.py` excerpt)

The admin token is stored in **SSM Parameter Store**. The API loads it (and caches it in memory for warm Lambda invocations), then checks it against the `x-admin-token` header for privileged routes.

```python
,
            "Access-Control-Allow-Headers": "Content-Type,x-admin-token",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
        "body": json.dumps(body),
    }


def _get_admin_token() -> str:
    global _cached_admin_token
    if _cached_admin_token:
        return _cached_admin_token

    resp = ssm.get_parameter(Name=ADMIN_TOKEN_PARAM, WithDecryption=True)
    _cached_admin_token = resp["Parameter"]["Value"]
    return _cached_admin_token


def _require_admin(headers: dict):
    provided = ""
    for k, v in (headers or {}).items():
        if k.lower() == "x-admin-token":
            provided = v
            break

    if not provided:
        return False, _resp(401, {"error": "Missing x-admin-token header"})

    if provided != _get_admin_token():
        return False, _resp(403, {"error": "Invalid admin token"})

    return True, None


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "") or event.get("path", "")
    headers = event.get("headers") or
```

### Main Lambda handler routing (`api/app.py` excerpt)

This is the “router” for the API:

```python
return False, _resp(401, {"error": "Missing x-admin-token header"})

    if provided != _get_admin_token():
        return False, _resp(403, {"error": "Invalid admin token"})

    return True, None


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "") or event.get("path", "")
    headers = event.get("headers") or {}
    qs = event.get("queryStringParameters") or {}
    path_params = event.get("pathParameters") or {}

    # Preflight
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    # Health
    if method == "GET" and path in ("/health", "/api/health"):
        return _resp(200, {"ok": True})

    if not DDB_TABLE:
        return _resp(500, {"error": "POSTS_TABLE_NAME env var not set"})

    table = ddb.Table(DDB_TABLE)

    # GET /api/posts  (list)
    if method == "GET" and path == "/api/posts":
        try:
            res = table.scan(ProjectionExpression="post_id,title,created_at")
            items = res.get("Items", [])
            # newest first (best-effort)
            items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
            return _resp(200, {"items": items})
        except ClientError as e:
            return _resp(500, {"error": str(e)})

    # GET /api/posts/{id}
    if method == "GET" and path.startswith("/api/posts/"):
        post_id = path.split("/api/posts/")[1].strip("/")
        if not post_id:
            return _resp(400, {"error": "Missing post id"})
        try:
            res = table.get_item(Key={"post_id": post_id}, ProjectionExpression="post_id,title,created_at,content")
            item = res.get("Item")
            if not item:
                return _resp(404, {"error": "Not found"})
            return _resp(200, {"item": item})
        except ClientError as e:
            return _resp(500, {"error": str(
```

### Create/update posts (`api/app.py` excerpt)

Admin-only post creation/update:

```python

    # POST /api/posts  (create/update)
    if method == "POST" and path == "/api/posts":
        ok, denial = _require_admin(headers)
        if not ok:
            return denial

        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return _resp(400, {"error": "Invalid JSON body"})

        post_id = (body.get("post_id") or "").strip()
        title = (body.get("title") or "").strip()
        content = (body.get("content") or "").strip()

        if not post_id or not title:
            return _resp(400, {"error": "post_id and title are required"})

        created_at = body.get("created_at") or datetime.utcnow().strftime("%Y-%m-%d")

        item = {
            "post_id": post_id,
            "title": title,
            "created_at": created_at,
        }
        if content:
            item["content"] = content

        try:
            table.put_item(Item=item)
            return _resp(200, {"message": "ok", "item": {"post_id": post_id, "title": title, "created_at": created_at}})
        except ClientError as e:
            return _resp(500, {"error": str(e)})


```

---

## Security Considerations

This project is small, but it still follows a few non-negotiables:

- **No long-lived AWS keys in CI**: Bitbucket OIDC assumes a role
- **Private S3 bucket**: CloudFront OAC is the only path to the origin
- **Admin token is not in source control**: stored in SSM as a secure parameter
- **Admin endpoints require a token**:
  - `POST /api/posts`
  - `DELETE /api/posts/{post_id}`

What this does *not* attempt to do:
- user accounts
- JWT auth
- rate limiting / WAF
- full RBAC

For a personal site, the goal is “secure enough without becoming a product.”

---

## What’s Next

A few improvements I’ll likely add over time:

- **Observability**: structured logging + metrics/alarms
- **Validation**: lint/format checks and markdown validation in CI
- **Content workflow**: local preview tooling and better post authoring UX
