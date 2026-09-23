---
id: unit-testing-network-automation
title: Unit Testing Network Automation Code with Pytest
published: 2026-09-23
excerpt: A practical approach to testing network automation logic, configuration rendering, validation, and API clients with pytest.
tags:
  - python
  - automation
  - testing
  - pytest
  - netbox
---
# Unit Testing Network Automation Code with Pytest

Network automation can make infrastructure changes faster and more consistent, but it can also apply the same mistake to many devices very quickly. Unit tests provide a fast feedback loop before code reaches a lab, a pull request, or a production device.

> **The goal of unit testing:** A unit test cannot prove that a device will accept a command or that a production route will converge correctly. It can prove that the code generated the expected command, rejected an unsafe input, or handled an API response correctly.

This article uses `pytest` to test a small Python module that:

- normalizes interface data
- validates addresses and MTU values
- renders a Cisco-style interface configuration
- retrieves a device from a NetBox-style API

The goal is not to test a router or NetBox itself. The goal is to prove that **our code makes the correct decisions** for known inputs, edge cases, and failures.

---

## What Makes a Good Unit Test?

A useful unit test is:

- **Focused** — it verifies one behavior
- **Repeatable** — it produces the same result every time
- **Fast** — it does not wait for real devices or external services
- **Independent** — it does not rely on another test running first
- **Readable** — the test name and assertions explain the expected behavior

For network automation, good unit-test targets include:

- parsing and normalizing source-of-truth data
- validating IP addresses, VLANs, ASNs, and interface attributes
- rendering configuration from structured data
- selecting devices or templates based on business rules
- handling empty, malformed, or incomplete API responses
- deciding whether a proposed change is safe to continue

Connecting to a real switch is usually an integration or end-to-end test. That work is still valuable, but it belongs in a different layer of the test strategy.

---

## Unit Testing vs. Linting

Linting and unit testing both help catch problems before automation reaches production, but they inspect different things.

| Linting | Unit Testing |
| --- | --- |
| Examines source code without exercising its business behavior | Executes code with controlled inputs |
| Finds undefined names, unused imports, suspicious patterns, and style problems | Verifies that the program produces the expected result |
| Understands Python rules and common coding mistakes | Understands the requirements explicitly encoded in tests |
| Common tools include Ruff, Flake8, and Pylint | Common tools include pytest and unittest |

For example, a linter can determine that the following is valid, well-formatted Python:

```python
if not 576 <= mtu <= 9216:
    raise ValueError("Invalid MTU")
```

It generally cannot determine whether `576` and `9216` are the correct limits for this application. A unit test expresses that requirement:

```python
@pytest.mark.parametrize("mtu", [575, 9217])
def test_rejects_invalid_mtu(mtu):
    with pytest.raises(ValueError):
        normalize_interface(
            {
                "name": "GigabitEthernet0/1",
                "address": "10.0.0.1/24",
                "mtu": mtu,
            }
        )
```

The same distinction applies to configuration rendering. A linter can confirm that the renderer contains valid Python and does not use an undefined variable. It cannot know that the intended result is exactly:

```text
interface GigabitEthernet0/1
 ip address 10.20.30.1 255.255.255.0
 no shutdown
```

That expected behavior must be described by a test.

The `normalize_interface()` function used in this article performs **runtime input validation**. That is not linting. The unit tests verify that the validation accepts supported values, rejects unsafe values, and applies defaults correctly.

A healthy automation pipeline normally uses all three layers:

1. **Linting** — Is the code structurally clean and free of common mistakes?
2. **Type checking** — Are values being used consistently?
3. **Unit testing** — Does the code behave according to the project’s requirements?

These checks complement one another. Passing a linter does not prove that the code makes the correct decision, and passing unit tests does not guarantee that the code is clean, consistently typed, or free of every suspicious pattern.

---

## Example Project Layout

The example uses a small Python package and keeps the tests separate from the application code:

```text
network-testing-demo/
├── network_automation/
│   ├── __init__.py
│   ├── interfaces.py
│   └── netbox.py
├── tests/
│   ├── test_interfaces.py
│   └── test_netbox.py
└── pyproject.toml
```

Create a virtual environment and install the test dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install pytest pytest-cov requests
```

A small `pyproject.toml` file gives pytest a consistent configuration:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra"
```

---

## The Code Under Test

The first function takes interface data from an external source and converts it into a predictable internal format. It also rejects values that the rest of the automation should not accept.

**`network_automation/interfaces.py`**

```python
from ipaddress import IPv4Interface, ip_interface


def normalize_interface(raw: dict) -> dict:
    """Validate and normalize one interface record."""
    name = str(raw.get("name", "")).strip()
    if not name:
        raise ValueError("interface name is required")

    address_value = str(raw.get("address", "")).strip()
    try:
        address = ip_interface(address_value)
    except ValueError as exc:
        raise ValueError(f"invalid interface address: {address_value}") from exc

    if not isinstance(address, IPv4Interface):
        raise ValueError("this renderer currently supports IPv4 only")

    mtu = int(raw.get("mtu", 1500))
    if not 576 <= mtu <= 9216:
        raise ValueError("MTU must be between 576 and 9216")

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be a boolean")

    return {
        "name": name,
        "description": str(raw.get("description", "")).strip(),
        "address": str(address),
        "mtu": mtu,
        "enabled": enabled,
    }


def render_interface_config(raw: dict) -> str:
    """Render a small Cisco-style interface configuration."""
    interface = normalize_interface(raw)
    address = ip_interface(interface["address"])

    lines = [f"interface {interface['name']}"]
    if interface["description"]:
        lines.append(f" description {interface['description']}")

    lines.extend(
        [
            f" ip address {address.ip} {address.netmask}",
            f" mtu {interface['mtu']}",
            " no shutdown" if interface["enabled"] else " shutdown",
        ]
    )
    return "\n".join(lines) + "\n"
```

There are two important design choices here:

1. Validation is kept in a normal Python function instead of being mixed into a device connection.
2. Rendering returns a string and has no side effects.

Those choices make both behaviors easy to test without a network connection.

---

## Testing the Expected Path

A pytest test is a function whose name begins with `test_`. The test prepares input, runs the code, and asserts the expected result.

**`tests/test_interfaces.py`**

```python
from textwrap import dedent

import pytest

from network_automation.interfaces import (
    normalize_interface,
    render_interface_config,
)


@pytest.fixture
def interface_data() -> dict:
    return {
        "name": "GigabitEthernet0/1",
        "description": " Uplink to distribution-01 ",
        "address": "10.20.30.1/24",
        "mtu": 1500,
        "enabled": True,
    }


def test_normalize_interface_returns_expected_data(interface_data):
    result = normalize_interface(interface_data)

    assert result == {
        "name": "GigabitEthernet0/1",
        "description": "Uplink to distribution-01",
        "address": "10.20.30.1/24",
        "mtu": 1500,
        "enabled": True,
    }


def test_normalize_interface_applies_defaults():
    result = normalize_interface(
        {
            "name": "Loopback0",
            "address": "10.255.0.1/32",
        }
    )

    assert result["description"] == ""
    assert result["mtu"] == 1500
    assert result["enabled"] is True


def test_render_interface_config(interface_data):
    result = render_interface_config(interface_data)

    expected = dedent(
        """\
        interface GigabitEthernet0/1
         description Uplink to distribution-01
         ip address 10.20.30.1 255.255.255.0
         mtu 1500
         no shutdown
        """
    )
    assert result == expected
```

The fixture supplies reusable input without creating hidden global state. Each test receives a fresh dictionary, and each assertion documents an expected behavior.

---

## Testing Invalid and Boundary Values

The success path is only part of the story. Automation should also fail clearly when the input is unsafe or malformed.

`pytest.raises()` verifies that invalid input produces the intended exception:

```python
def test_normalize_interface_rejects_invalid_address():
    with pytest.raises(ValueError, match="invalid interface address"):
        normalize_interface(
            {
                "name": "GigabitEthernet0/1",
                "address": "not-an-address",
            }
        )
```

Parametrization runs the same test logic against multiple values. This is useful for boundaries such as VLAN IDs, prefix lengths, and MTUs.

```python
@pytest.mark.parametrize("mtu", [575, 0, 9217])
def test_normalize_interface_rejects_invalid_mtu(mtu):
    with pytest.raises(ValueError, match="MTU must be between"):
        normalize_interface(
            {
                "name": "GigabitEthernet0/1",
                "address": "10.20.30.1/24",
                "mtu": mtu,
            }
        )
```

This single test becomes three independent test cases in the pytest output.

It is also worth testing the boundary values that should be accepted:

```python
@pytest.mark.parametrize("mtu", [576, 1500, 9216])
def test_normalize_interface_accepts_valid_mtu_boundaries(mtu):
    result = normalize_interface(
        {
            "name": "GigabitEthernet0/1",
            "address": "10.20.30.1/24",
            "mtu": mtu,
        }
    )

    assert result["mtu"] == mtu
```

Testing both sides of a boundary helps catch off-by-one mistakes that a normal value such as `1500` would never reveal.

---

## Mocking an External API

Network automation frequently depends on NetBox, a controller, or another API. A unit test should not depend on that service being reachable. Instead, it can replace the HTTP session with a mock and control the response.

**`network_automation/netbox.py`**

```python
import requests


def get_device_by_name(
    base_url: str,
    token: str,
    name: str,
    session=requests,
) -> dict:
    response = session.get(
        f"{base_url.rstrip('/')}/api/dcim/devices/",
        params={"name": name},
        headers={"Authorization": f"Token {token}"},
        timeout=10,
    )
    response.raise_for_status()

    results = response.json().get("results", [])
    if len(results) != 1:
        raise LookupError(f"expected one device named {name}, found {len(results)}")

    return results[0]
```

The function accepts a session as a dependency. Production code uses `requests`, while a test can provide a `Mock` object.

**`tests/test_netbox.py`**

```python
from unittest.mock import Mock

import pytest

from network_automation.netbox import get_device_by_name


def test_get_device_by_name_returns_matching_device():
    response = Mock()
    response.json.return_value = {
        "results": [{"id": 42, "name": "edge-01", "status": "active"}]
    }
    session = Mock()
    session.get.return_value = response

    result = get_device_by_name(
        "https://netbox.example.com/",
        "test-token",
        "edge-01",
        session=session,
    )

    assert result["id"] == 42
    assert result["name"] == "edge-01"
    response.raise_for_status.assert_called_once_with()
    session.get.assert_called_once_with(
        "https://netbox.example.com/api/dcim/devices/",
        params={"name": "edge-01"},
        headers={"Authorization": "Token test-token"},
        timeout=10,
    )


def test_get_device_by_name_rejects_empty_results():
    response = Mock()
    response.json.return_value = {"results": []}
    session = Mock()
    session.get.return_value = response

    with pytest.raises(LookupError, match="expected one device"):
        get_device_by_name(
            "https://netbox.example.com",
            "test-token",
            "missing-device",
            session=session,
        )
```

These tests verify our URL, query parameters, authentication header, timeout, response handling, and error behavior. They do not attempt to prove that the `requests` library or NetBox works internally.

That distinction keeps the tests fast and makes failures easier to diagnose.

---

## Running the Test Suite

Run the tests from the project root:

```bash
pytest -q
```

The completed example produces output similar to:

```text
............                                                             [100%]
12 passed in 0.08s
```

The exact time will vary. More important than the runtime is that the tests do not require credentials, a lab, or internet access.

During development, a useful workflow is to run a specific test file or stop after the first failure:

```bash
pytest tests/test_interfaces.py -q
pytest -x
```

---

## Measuring Coverage Without Chasing a Number

Coverage shows which lines were executed while the tests ran:

```bash
pytest --cov=network_automation --cov-report=term-missing
```

Coverage is useful for finding untested branches, but a high percentage does not guarantee useful tests. A test suite can execute every line while making weak or incorrect assertions.

I treat coverage as a prompt for questions:

- Which failure paths have not been exercised?
- Have both accepted and rejected boundary values been tested?
- What happens when an API returns no objects or multiple objects?
- Does rendered configuration match the exact syntax I expect?

The quality of the assertions matters more than reaching an arbitrary percentage.

---

## Running Tests in GitHub Actions

Once the tests run locally, they can become a required check on every pull request.

**`.github/workflows/tests.yml`**

```yaml
name: Unit tests

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - name: Check out the repository
        uses: actions/checkout@v7

      - name: Set up Python
        uses: actions/setup-python@v7
        with:
          python-version: "3.13"
          cache: pip

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          python -m pip install pytest pytest-cov requests

      - name: Run tests
        run: pytest --cov=network_automation --cov-report=term-missing
```

The same tests now run in a clean environment instead of relying on packages or settings installed on a developer workstation. If a test fails, the pull request shows the failure before the automation code is merged.

---

## Unit Tests Are One Layer of Safety

Unit tests are best at checking deterministic logic. They should be combined with other safeguards:

1. **Static checks** — formatting, linting, and type checking
2. **Unit tests** — validation, transformation, rendering, and decision logic
3. **Integration tests** — communication with a real API or virtual lab
4. **Pre-change checks** — reachability, current state, and dependency validation
5. **Post-change checks** — routing, interface state, service health, and rollback criteria

A unit test cannot prove that a device will accept a command or that a production route will converge correctly. It can prove that the code generated the expected command, rejected an unsafe input, or handled an API response correctly.

That is a meaningful reduction in risk, especially because these tests run in seconds and can be executed on every change.

---

## Key Takeaways

- Separate decision logic from device and API connections.
- Test both successful behavior and failure behavior.
- Use fixtures for clear, reusable test data.
- Use parametrization for boundaries and input combinations.
- Mock external systems at the unit-test boundary.
- Compare rendered configurations exactly when whitespace and ordering matter.
- Run the same test suite locally and in CI.
- Use coverage to find gaps, not as the only measure of quality.

The most valuable result is confidence: a small change to a parser, validation rule, or template can be checked immediately before it becomes an infrastructure change.

---

## References

- [pytest documentation](https://docs.pytest.org/en/stable/)
- [Parametrizing tests with pytest](https://docs.pytest.org/en/stable/how-to/parametrize.html)
- [Building and testing Python with GitHub Actions](https://docs.github.com/en/actions/tutorials/build-and-test-code/python)
