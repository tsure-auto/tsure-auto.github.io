---
id: containerlab-netbox-basic
title: Basic Netbox -> Containerlab Pipeline Demo
published: 2026-01-10
excerpt: A high-level demo of using Netbox as a SoT to generate Containerlab labs.
tags:
  - python
  - cisco
  - netbox
  - automation
  - containerlab
  - sot
---
# Overview
This project is a proof-of-concept automation pipeline that uses NetBox as a Source of Truth to dynamically generate and deploy containerlab network topologies in real-time to simulate automated Infrastructure as Code driven changes.

The goal is to demonstrate how modern network automation can shift an organization from manual, device-centric workflows to event-driven, declarative infrastructure.

---

## High-Level Runtime Architecture

When a user edits an object in the NetBox UI or via NetBox API, NetBox automatically emits a webhook containing:

- The event type (created, updated, deleted)
- The full object payload

![Netbox Webhook Configuration Example](/assets/blog-images/netbox_webhook.png)

*Netbox Webhook Configuration.*

![Netbox Event Rule Configuration Example](/assets/blog-images/netbox_eventrule.png)

*Netbox Event Rule Configuration.*

Upon receiving a POST from NetBox, The Webhook Receiver (Flask app):

- Parses the event and object-type
- Compares pre-change and post-change snapshots
- Determines whether the change is meaningful enough to deploy
  - Examples of when not to deploy can be changes such as description. Basically anything that doesn't impact configurations
- Logs the decision
- Triggers an execution, when required

#### webhook_server.py
```python
from flask import Flask, request, jsonify
import subprocess
import os
import sys
from datetime import datetime

app = Flask(__name__)

REPO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEPLOY_SCRIPT = os.path.join(REPO_DIR, "scripts", "deploy_from_netbox.sh")

def run_deploy():
    # Run deploy INSIDE the OrbStack Ubuntu VM (where containerlab + deps exist)
    proc = subprocess.run(
        [
            "orb", "run",
            "-m", "ubuntu",
            "-p",
            "-w", "/Projects/netbox-containerlab-poc",
            "bash", "-lc",
            "source .venv/bin/activate && bash scripts/deploy_from_netbox.sh"
        ],
        capture_output=True,
        text=True
    )
    return proc.returncode, proc.stdout, proc.stderr

@app.route("/netbox-webhook", methods=["POST"])
def netbox_webhook():
    payload = request.get_json(silent=True) or {}

    print("\n=== Received webhook from NetBox ===")
    print("Time:", datetime.now().isoformat())
    print("Headers:", dict(request.headers))
    print("JSON body:", payload)

    # Only react to device updates
    if payload.get("event") != "updated" or payload.get("model") != "device":
        print("Ignoring: not a device update event")
        return jsonify({"status": "ignored"}), 200

    snapshots = payload.get("snapshots") or {}
    pre = snapshots.get("prechange") or {}
    post = snapshots.get("postchange") or {}

    # Only redeploy if hostname changed
    pre_name = pre.get("name") or pre.get("display")
    post_name = post.get("name") or post.get("display")

    if not pre_name or not post_name:
        print("Ignoring: missing prechange/postchange name")
        return jsonify({"status": "ignored_missing_names"}), 200

    if pre_name == post_name:
        print(f"Ignoring: hostname unchanged ({post_name})")
        return jsonify({"status": "no-op"}), 200

    print(f"Hostname changed: {pre_name} -> {post_name}. Triggering deploy...")
    rc, out, err = run_deploy()

    if rc == 0:
        print("Deploy stdout:", out)
        print("Deploy stderr:", err)
        return jsonify({"status": "deployment triggered"}), 200
    else:
        print("Deploy failed stdout:", out)
        print("Deploy failed stderr:", err)
        return jsonify({"status": "deploy failed", "returncode": rc}), 500



if __name__ == "__main__":
    # Bind all interfaces so NetBox container can reach it via LAN IP
    app.run(host="0.0.0.0", port=5001)

```

#### deploy_from_netbox.sh

```bash
#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo ">>> Activating venv..."
source .venv/bin/activate

echo ">>> Destroying existing lab (if any)..."
sudo containerlab destroy --name netbox-auto-lab --cleanup || true

echo ">>> Regenerating topology from NetBox..."
python3 scripts/generate_lab_from_netbox.py

echo ">>> Deploying lab with containerlab..."
sudo containerlab deploy --topo auto_generated_lab.clab.yml --name netbox-auto-lab

echo ">>> Deployment complete!"

```

#### generate_lab_from_netbox.py

```python
import yaml
import pynetbox
import os
from dotenv import load_dotenv

load_dotenv()

NETBOX_URL = os.getenv("NETBOX_URL")
NETBOX_TOKEN = os.getenv("NETBOX_TOKEN")
nb = pynetbox.api(NETBOX_URL, token=NETBOX_TOKEN)

# ---- Pull all devices with interfaces ----
devices = nb.dcim.devices.all()
interfaces = nb.dcim.interfaces.all()
cables = nb.dcim.cables.all()

# ---- Build node definitions ----
nodes = {}
for device in devices:
    nodes[device.name] = {
        "kind": "linux",
        "image": "alpine:latest"
    }

# ---- Build links from cables ----
links = []
for cable in cables:
    a_side = cable.a_terminations[0]
    b_side = cable.b_terminations[0]

    a_dev = a_side.device.name
    a_int = a_side.name

    b_dev = b_side.device.name
    b_int = b_side.name

    links.append({
        "endpoints": [f"{a_dev}:{a_int}", f"{b_dev}:{b_int}"]
    })

# ---- Build final containerlab topology ----
lab = {
    "name": "netbox-auto-lab",
    "topology": {
        "nodes": nodes,
        "links": links
    }
}

# ---- Write output file ----
with open("auto_generated_lab.clab.yml", "w") as f:
    yaml.dump(lab, f, default_flow_style=False)

print("Generated: auto_generated_lab.clab.yml")
```


Once the Webhook Receiver determines that a redeploy is required, execution begins and the following actions are taken:

- Current containerlab environment is destroyed
- Queries NetBox for current state
  - Uses tags to only query certain devices in NetBox
- Renders a new toplogy file from that state
- Deploys the toplogy using Containerlab

#### An example of the `auto_generated_lab.clab.yml` that is created

```yaml
name: netbox-auto-lab
topology:
  links:
  - endpoints:
    - r1:eth1
    - r2:eth1
  nodes:
    r1:
      image: alpine:latest
      kind: linux
    r2:
      image: alpine:latest
      kind: linux
```

Below is an example of the stdout from the web server showing an object (hostname in this case) was modified in Netbox. This event triggered a POST, which then triggers a redeploy of the containerlab environment.

```text
=== Received webhook from NetBox ===
Time: 2026-01-10T12:29:44.986209
Headers: {'Host': '192.168.50.195:5001', 'Accept-Encoding': 'identity', 'User-Agent': 'python-urllib3/2.5.0', 'Content-Type': 'application/json', 'Content-Length': '3652'}
JSON body: {'event': 'updated', 'timestamp': '2026-01-10T17:29:44.950479+00:00', 'object_type': 'dcim.device', 'model': 'device', 'username': 'admin', 'request_id': '951c8026-4594-49d3-bebc-f72e32d9441a', 'data': {'id': 4, 'url': '/api/dcim/devices/4/', 'display_url': '/dcim/devices/4/', 'display': 'r2', 'name': 'r2', 'device_type': {'id': 1, 'url': '/api/dcim/device-types/1/', 'display': 'frr-node', 'manufacturer': {'id': 1, 'url': '/api/dcim/manufacturers/1/', 'display': 'Containerlab', 'name': 'Containerlab', 'slug': 'containerlab', 'description': ''}, 'model': 'frr-node', 'slug': 'frr-node', 'description': ''}, 'role': {'id': 1, 'url': '/api/dcim/device-roles/1/', 'display': 'Router', 'name': 'Router', 'slug': 'router', 'description': '', 'device_count': 0, 'virtualmachine_count': 0, '_depth': 0}, 'tenant': None, 'platform': None, 'serial': '', 'asset_tag': None, 'site': {'id': 1, 'url': '/api/dcim/sites/1/', 'display': 'lab', 'name': 'lab', 'slug': 'lab', 'description': ''}, 'location': None, 'rack': None, 'position': None, 'face': None, 'latitude': None, 'longitude': None, 'parent_device': None, 'status': {'value': 'active', 'label': 'Active'}, 'airflow': None, 'primary_ip': None, 'primary_ip4': None, 'primary_ip6': None, 'oob_ip': None, 'cluster': None, 'virtual_chassis': None, 'vc_position': None, 'vc_priority': None, 'description': '', 'comments': '', 'config_template': None, 'local_context_data': None, 'tags': [{'id': 1, 'url': '/api/extras/tags/1/', 'display_url': '/extras/tags/1/', 'display': 'lab', 'name': 'lab', 'slug': 'lab', 'color': '607d8b'}], 'custom_fields': {}, 'created': '2025-11-24T15:27:32.263631Z', 'last_updated': '2026-01-10T17:29:44.902492Z', 'console_port_count': 0, 'console_server_port_count': 0, 'power_port_count': 0, 'power_outlet_count': 0, 'interface_count': 1, 'front_port_count': 0, 'rear_port_count': 0, 'device_bay_count': 0, 'module_bay_count': 0, 'inventory_item_count': 0}, 'snapshots': {'prechange': {'created': '2025-11-24T15:27:32.263Z', 'description': '', 'comments': '', 'local_context_data': None, 'config_template': None, 'device_type': 1, 'role': 1, 'tenant': None, 'platform': None, 'name': 'r2-changed', 'serial': '', 'asset_tag': None, 'site': 1, 'location': None, 'rack': None, 'position': None, 'face': None, 'status': 'active', 'airflow': None, 'primary_ip4': None, 'primary_ip6': None, 'oob_ip': None, 'cluster': None, 'virtual_chassis': None, 'vc_position': None, 'vc_priority': None, 'latitude': None, 'longitude': None, 'console_port_count': 0, 'console_server_port_count': 0, 'power_port_count': 0, 'power_outlet_count': 0, 'interface_count': 1, 'front_port_count': 0, 'rear_port_count': 0, 'device_bay_count': 0, 'module_bay_count': 0, 'inventory_item_count': 0, 'custom_fields': {}, 'tags': ['lab']}, 'postchange': {'created': '2025-11-24T15:27:32.263Z', 'last_updated': '2026-01-10T17:29:44.902Z', 'description': '', 'comments': '', 'local_context_data': None, 'config_template': None, 'device_type': 1, 'role': 1, 'tenant': None, 'platform': None, 'name': 'r2', 'serial': '', 'asset_tag': None, 'site': 1, 'location': None, 'rack': None, 'position': None, 'face': None, 'status': 'active', 'airflow': None, 'primary_ip4': None, 'primary_ip6': None, 'oob_ip': None, 'cluster': None, 'virtual_chassis': None, 'vc_position': None, 'vc_priority': None, 'latitude': None, 'longitude': None, 'console_port_count': 0, 'console_server_port_count': 0, 'power_port_count': 0, 'power_outlet_count': 0, 'interface_count': 1, 'front_port_count': 0, 'rear_port_count': 0, 'device_bay_count': 0, 'module_bay_count': 0, 'inventory_item_count': 0, 'custom_fields': {}, 'tags': ['lab']}}}
Hostname changed: r2-changed -> r2. Triggering deploy...
Deploy stdout: >>> Activating venv...
>>> Destroying existing lab (if any)...
>>> Regenerating topology from NetBox...
Generated: auto_generated_lab.clab.yml
>>> Deploying lab with containerlab...
🎉 A newer containerlab version (0.72.0) is available!
Release notes: https://containerlab.dev/rn/0.72/
Run 'sudo clab version upgrade' or see https://containerlab.dev/install/ for installation options.
╭─────────────────────────┬───────────────┬─────────┬───────────────────╮
│           Name          │   Kind/Image  │  State  │   IPv4/6 Address  │
├─────────────────────────┼───────────────┼─────────┼───────────────────┤
│ clab-netbox-auto-lab-r1 │ linux         │ running │ 172.20.20.3       │
│                         │ alpine:latest │         │ 3fff:172:20:20::3 │
├─────────────────────────┼───────────────┼─────────┼───────────────────┤
│ clab-netbox-auto-lab-r2 │ linux         │ running │ 172.20.20.2       │
│                         │ alpine:latest │         │ 3fff:172:20:20::2 │
╰─────────────────────────┴───────────────┴─────────┴───────────────────╯
>>> Deployment complete!

Deploy stderr: 12:29:45 INFO Parsing & checking topology file=auto_generated_lab.clab.yml
12:29:45 INFO Parsing & checking topology file=auto_generated_lab.clab.yml
12:29:45 INFO Destroying lab name=netbox-auto-lab
12:29:45 INFO Removed container name=clab-netbox-auto-lab-r1
12:29:45 INFO Removed container name=clab-netbox-auto-lab-r2-changed
12:29:45 INFO Removing host entries path=/etc/hosts
12:29:45 INFO Removing SSH config path=/etc/ssh/ssh_config.d/clab-netbox-auto-lab.conf
12:29:45 INFO Containerlab started version=0.71.1
12:29:45 INFO Parsing & checking topology file=auto_generated_lab.clab.yml
12:29:45 INFO Creating docker network name=clab IPv4 subnet=172.20.20.0/24 IPv6 subnet=3fff:172:20:20::/64 MTU=0
12:29:45 INFO Creating lab directory path=/Users/tsurento/Projects/netbox-containerlab-poc/clab-netbox-auto-lab
12:29:45 INFO unable to adjust Labdir file ACLs: operation not supported
12:29:45 INFO Creating container name=r2
12:29:45 INFO Creating container name=r1
12:29:45 INFO Created link: r1:eth1 ▪┄┄▪ r2:eth1
12:29:45 INFO Adding host entries path=/etc/hosts
12:29:45 INFO Adding SSH config for nodes path=/etc/ssh/ssh_config.d/clab-netbox-auto-lab.conf

192.168.50.195 - - [10/Jan/2026 12:29:46] "POST /netbox-webhook HTTP/1.1" 200 -
```
