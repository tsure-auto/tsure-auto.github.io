---
id: config-parsing
title: Parsing Network Configurations into Structured Data
published: 2026-01-14
excerpt: Concepts and patterns for parsing Cisco configurations into structured JSON/YAML for automation and analysis
tags:
  - python
  - cisco
  - netbox
  - automation
  - sot
---

# Overview

This post walks through the core concepts I use when parsing network device configurations—Cisco IOS in this case—into structured data formats such as JSON or YAML.

The focus here is **parsing strategy and code structure**, not:
- how configurations are collected
- how parsed data is stored
- or how deployments are executed

Instead, this post explains *how* to take raw configuration text and incrementally convert it into structured data that can later serve as a **source of truth**, a **reporting layer**, or an **input to templated configuration generation**.

---

## Problem Statement

Imagine joining an organization as a network automation engineer where automation has not historically been a priority.

Over time, the network has grown organically:
- devices were configured manually
- standards were loosely applied (or not at all)
- configurations drifted across platforms and sites

Before cleanup or standardization can occur, the first requirement is **visibility**.

One effective way to gain that visibility is to build a *source of truth* derived directly from existing device configurations.

To do that, we must first **parse configurations into structured data**.

For example, if a Cisco `show running-config` can be converted into JSON or YAML, we gain the ability to:
- reason about configurations programmatically
- detect inconsistencies across devices
- generate templates from existing state
- apply controlled changes at scale

> Once configuration becomes data, automation becomes significantly easier and safer.

---

## Why Not Just Use NTC Templates?

NTC templates can be useful in some cases, but they rely heavily on TextFSM patterns and tend to become difficult to extend or debug as parsing complexity grows.

The approach described here favors:
- explicit Python logic
- regex patterns scoped to small, testable units
- a clear separation between parsed and unparsed configuration lines

This makes it easier to iterate, validate, and gradually expand coverage over time.

---

## Parsing Cisco `show running-config` Output

Below is a simplified project layout illustrating how parsing responsibilities are separated by concern:

```
/input_configs
  test_input_config.txt
/custom_parsers
  cisco_generic_parser.py
  cisco_interface_parser.py
  generic.py
  interface.py
/parsed_outputs
/unparsed_outputs
config_parser.py
```

---

## `config_parser.py`

The main parser script is responsible for:
- reading configuration files
- initializing the data schema
- passing configuration text through each parser
- tracking which lines remain unparsed
- writing both parsed and unparsed outputs

```python
from custom_parsers.cisco_interface_parser import parse_cisco_interface
from custom_parsers.cisco_generic_parser import parse_cisco_generic
from custom_parsers.cisco_routing_parser import parse_cisco_routing

CONFIG_DIR = "directory/where/configs/are/stored"
UNPARSED_DIR = "directory/where/unparsed/configs/are/stored/after/run/completes"
OUTPUT_DIR = "directory/where/parsed_configs/are/stored/after_run_completes"

def run_parser():
    for filename in tqdm(sorted(os.listdir(CONFIG_DIR))):
        file_path = os.path.join(CONFIG_DIR, filename)

        with open(file_path, "r") as f:
            config_text = f.read()

        lines = config_text.splitlines()
        unparsed_lines = {i: line for i, line in enumerate(lines, start=1)}

        parsed_data = {
            "generic": {},
            "interface": {},
            "routing": {}
        }

        try:
            generic_data, unparsed_lines = parse_cisco_generic(config_text, unparsed_lines)
            parsed_data["generic"] = generic_data

            interface_data, unparsed_lines = parse_cisco_interface(config_text, unparsed_lines)
            parsed_data["interface"] = interface_data

        except Exception as e:
            logger.exception(f"Error parsing {filename}: {e}")

        with open(os.path.join(OUTPUT_DIR, f"{filename}_parsed.json"), "w") as f:
            json.dump(parsed_data, f, indent=2)

        filtered_unparsed_lines = {
            ln: line
            for ln, line in unparsed_lines.items()
            if not ignore_lines(line)
        }

        with open(os.path.join(UNPARSED_DIR, f"{filename}_unparsed.txt"), "w") as f:
            for ln in sorted(filtered_unparsed_lines.keys()):
                f.write(f"{ln:6d}: {filtered_unparsed_lines[ln]}\n")

if __name__ == "__main__":
    run_parser()
```

---

## Line-Based Parsing with Regex

Each parser iterates over the remaining unparsed lines and attempts to match known patterns.

Below is an example from the generic parser, where we extract global configuration values such as version and hostname:

`custom_parsers/cisco_generic_parser.py`
```python

from collections import defaultdict
from typing import Dict
from .generic import *

def parse_cisco_generic(config_text: str, unparsed_lines: dict[int, str]) -> Dict:
    parsed = defaultdict(dict)

    for lineno, line in list(unparsed_lines.items()):
        if parsed_version := CiscoVersionLine.try_parse(line):
            parsed["version"] = parsed_version.version
            del unparsed_lines[lineno]

        elif parsed_hostname := CiscoHostnameLine.try_parse(line):
            parsed["hostname"] = parsed_hostname.hostname
            del unparsed_lines[lineno]

    return parsed, unparsed_lines
```

---

## Regex-Backed Line Parsers

Each configuration line type is represented as a small, focused class with:
- a regex pattern
- a typed data structure
- a consistent parsing interface

`custom_parsers/generic_parser.py`
```python
import re
import dataclasses
from typing import ClassVar
from .base import BaseLineParser

@dataclasses.dataclass(frozen=True)
class CiscoVersionLine(BaseLineParser):
    PATTERN: ClassVar[re.Pattern] = re.compile(r"^version\s(?P<version>\S+)$")
    version: str

    @classmethod
    def from_match(cls, match):
        return cls(version=match.group("version"))
```

---

## Handling Nested Configuration Sections

Some configuration blocks—interfaces, routing protocols, VRFs, ACLs—are hierarchical.

The parsing strategy remains the same, but with additional context tracking. We initially set `current_interface` to None (and subsequently overwrite when we find nested configs)  to track the nesting heirarchy in the configurations structure and replicate in our output.

`custom_parsers/cisco_interface_parser.py`
```python
def parse_cisco_interface(config_text: str, unparsed_lines: dict[int, str]) -> Dict:
    parsed = defaultdict(dict)
    current_interface = None

    for lineno, line in list(unparsed_lines.items()):
        if parsed_interface := CiscoInterfaceLine.try_parse(line):
            current_interface = parsed_interface.interface_name
            parsed[current_interface] = {}
            del unparsed_lines[lineno]
            continue

        if parsed_speed := CiscoInterfaceSpeedLine.try_parse(line):
            if current_interface is not None:
                parsed[current_interface]["speed"] = parsed_speed.speed
                del unparsed_lines[lineno]

    return parsed, unparsed_lines
```

---

## Final Thoughts

This parsing model prioritizes:
- incremental coverage
- visibility into unparsed configuration
- maintainable, testable parsing logic

Rather than attempting to parse everything at once, this approach encourages gradual refinement while always preserving insight into what remains unknown.
