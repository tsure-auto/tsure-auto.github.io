---
id: python-logging
title: Logging in Python
published: 2026-01-25
excerpt: Logging in python
tags:
  - python
  - automation
---
# Python Logging: Going Beyond the Basics

Python’s `logging` module is a core part of the standard library and is designed to scale from small scripts to large, long‑running systems. While it’s often introduced as a replacement for `print()`, logging is better thought of as **application telemetry**: structured, configurable signals about what your software is doing over time.

This article focuses on **practical, production‑oriented logging concepts**—how logging is structured internally, how to configure it cleanly, and how to avoid common pitfalls that only show up as systems grow.

---

## 1. Why Use Logging Instead of `print()`

The `print()` function is simple and useful for quick experiments, but it has limitations in real applications:

* No built‑in severity levels
* No consistent formatting across modules
* No easy way to route output to different destinations
* Limited control in concurrent or multi‑process programs

The `logging` module addresses these concerns by providing **levels, handlers, formatters, and filters**, all of which can be configured without changing call sites.

---

## 2. Core Logging Components

Python logging is built around four main concepts:

1. **Loggers** – Named entry points created with `logging.getLogger(name)`
2. **Handlers** – Destinations for log records (console, file, syslog, etc.)
3. **Formatters** – Control how log records are rendered
4. **Filters** – Optional rules for including or excluding records

Understanding how these pieces interact makes it much easier to reason about logging behavior in larger codebases.

---

## 3. Logger Names, Hierarchy, and Propagation

Logger names form a dot‑separated hierarchy:

```text
app
app.db
app.db.migrations
app.api
```

```python
logger = logging.getLogger("app.db")
```

By default:

* Log records propagate from child loggers to their parents
* Handlers attached to parent loggers receive records from children

This design allows you to configure handlers and levels at a high level while keeping logging calls local to each module.

### Recommended pattern

* Attach handlers at the application root (or a small number of well‑defined entry points)
* Let child loggers inherit configuration

```python
logger = logging.getLogger("app.db")
logger.info("Database connection established")
```

---

## 4. Choosing Log Levels Thoughtfully

Log levels communicate intent and expected severity:

| Level    | Typical Use Case                            |
| -------- | ------------------------------------------- |
| DEBUG    | Detailed diagnostic information             |
| INFO     | Normal operational messages                 |
| WARNING  | Unexpected situations that are recoverable  |
| ERROR    | A specific operation failed                 |
| CRITICAL | The application may not be able to continue |

A useful guideline is to ensure that:

* `INFO` logs are meaningful in production
* `DEBUG` logs provide additional depth without being required for correctness

---

## 5. Performance Considerations

Logging calls are inexpensive, but **log message construction can be costly** if it performs work unnecessarily.

```python
logger.debug(f"Result: {expensive_function()}")
```

Even if DEBUG logging is disabled, `expensive_function()` is still evaluated.

---

## 6. Adding Context with Structured Logging

Plain text messages are human‑readable but harder for machines to process. Structured logging adds context in a consistent way.

```python
logger.info(
    "request completed",
    extra={
        "user": user,
        "action": action,
        "status": status,
    },
)
```

A formatter can then reference these fields:

```python
"%(asctime)s %(levelname)s %(user)s %(action)s %(status)s"
```

This approach integrates well with log aggregation and search tools.

---

## 7. JSON Logging for Log Pipelines

Many modern systems prefer logs in JSON format for ingestion into tools like OpenSearch, ELK, or cloud logging platforms.

```python
import json
import logging

class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        })
```

Once attached to a handler, logs become machine‑readable without changing application code.

---

## 8. Log Rotation and Retention

Long‑running applications should rotate logs to avoid unbounded file growth.

```python
from logging.handlers import RotatingFileHandler

handler = RotatingFileHandler(
    "app.log",
    maxBytes=10_000_000,
    backupCount=5,
)
```

Time‑based rotation is also common:

```python
from logging.handlers import TimedRotatingFileHandler

handler = TimedRotatingFileHandler(
    "app.log",
    when="midnight",
    backupCount=14,
)
```

---

## 9. Logging Exceptions with Tracebacks

When handling exceptions, it’s often useful to retain full traceback information.

```python
try:
    risky_operation()
except Exception:
    logger.exception("Operation failed")
```

`logger.exception()` automatically includes the stack trace, which is invaluable during debugging and incident review.

---

## 10. Configuration with `dictConfig`

For non‑trivial systems, declarative configuration scales better than ad‑hoc setup code.

```python
from logging.config import dictConfig

dictConfig({
    "version": 1,
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
        }
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
})
```

This approach works well with environment‑specific configs and CI/CD pipelines.

---

## 11. Closing Thoughts

Logging is most effective when it is:

* Consistent across modules
* Structured enough for automation
* Lightweight enough to leave enabled

Treat logs as a long‑term interface to your system’s behavior. Thoughtful setup early on pays dividends when diagnosing issues later.
