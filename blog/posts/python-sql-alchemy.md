---
id: python-sql-alchemy
title: Building a Source of Truth with Python + SQLAlchemy
published: 2026-01-14
excerpt: Example of interacting with a database in python using SQLAlchemy.
tags:
  - python
  - databases
  - sqlalchemy
  - sot
---

# Populating a database with Python & SQLAlchemy to build a relational Source of Truth

A **Source of Truth (SoT)** is a single, authoritative, queryable representation of infrastructure state.

The goal is to reliably answer questions like:

* What networks exist?
* What subnets belong to them?
* Which route tables and routes are in use?
* What changed since the last run?

This post assumes the data is already collected.

This post focuses on the **database layer**, not data collection. We’ll use **simple but realistic test input** to demonstrate:

* Schema design
* Database setup
* Writing data
* Updating data without wiping the database
* Tracking changes over time

---

## What We’re Building

A minimal but realistic cloud-network SoT build with AWS data:

We’ll use:

* SQLite (single-file DB, easy to demo)
* SQLAlchemy (2.x style)
* Idempotent upserts (safe to re-run without clearing the database between runs)

---

## Project Structure

```text
sot/
├── app.py
├── db.py
├── models.py
├── seed_data.py
├── requirements.txt
├── settings.py
└── sot.db          # created automatically
```

---

## Step 1 - Setup environment


```bash
mkdir -p ~/sot-lab
cd ~/sot-lab

python3 -m venv .venv
source .venv/bin/activate

python -m pip install --upgrade pip
pip install "SQLAlchemy>=2.0"
```


---

## Step 2 - Create the db.py, models.py, and app.py files

**db.py**

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

DB_URL = "sqlite:///sot.db"

engine = create_engine(DB_URL, echo=False)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

def get_session():
    return SessionLocal()
```

**app.py**

```python
from db import engine
from models import Base

def init_db():
    Base.metadata.create_all(bind=engine)

if __name__ == "__main__":
    init_db()
    print("✅ Database initialized (tables created if missing).")
```

**models.py**

```python
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    String,
    DateTime,
    ForeignKey,
    UniqueConstraint,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)

    vpcs: Mapped[List["VPC"]] = relationship(back_populates="account")


class VPC(Base):
    __tablename__ = "vpcs"
    __table_args__ = (
        UniqueConstraint("account_id", "provider_vpc_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)

    provider_vpc_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    cidr_block: Mapped[str] = mapped_column(String(64), nullable=False)
    region: Mapped[str] = mapped_column(String(32), nullable=False)

    account: Mapped["Account"] = relationship(back_populates="vpcs")
    subnets: Mapped[List["Subnet"]] = relationship(back_populates="vpc")


class Subnet(Base):
    __tablename__ = "subnets"
    __table_args__ = (
        UniqueConstraint("vpc_id", "provider_subnet_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    vpc_id: Mapped[int] = mapped_column(ForeignKey("vpcs.id"), nullable=False)

    provider_subnet_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    cidr_block: Mapped[str] = mapped_column(String(64), nullable=False)
    subnet_type: Mapped[str] = mapped_column(String(32), nullable=False)

    vpc: Mapped["VPC"] = relationship(back_populates="subnets")


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    note: Mapped[Optional[str]] = mapped_column(String(256))


class ChangeEvent(Base):
    __tablename__ = "change_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), nullable=False)

    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_key: Mapped[str] = mapped_column(String(256), nullable=False)
    change_type: Mapped[str] = mapped_column(String(32), nullable=False)
    details: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

Now run it (this will also create the sot.db file):

```text
(.venv) user@Mac sot-lab % python app.py
✅ Database initialized (tables created if missing).
```

---

## Step 3 - Add seed data & "upsert" ingest process

**seed_data.py**

```python
TEST_INPUT = {
    "account": {"name": "prod"},
    "vpc": {
        "provider_vpc_id": "vpc-001",
        "name": "prod-main",
        "cidr_block": "10.10.0.0/16",
        "region": "us-east-1",
    },
    "subnets": [
        {
            "provider_subnet_id": "subnet-001",
            "name": "prod-public-a",
            "cidr_block": "10.10.1.0/24",
            "subnet_type": "public",
        },
        {
            "provider_subnet_id": "subnet-002",
            "name": "prod-private-a",
            "cidr_block": "10.10.11.0/24",
            "subnet_type": "private",
        },
    ],
}

```

**ingest.py**

```python
from sqlalchemy import select
from typing import Optional


from db import get_session
from models import Account, VPC, Subnet, Run, ChangeEvent
from seed_data import TEST_INPUT


def upsert(session, model, identity: dict, updates: dict):
    obj = session.execute(select(model).filter_by(**identity)).scalar_one_or_none()

    if obj is None:
        obj = model(**identity, **updates)
        session.add(obj)
        return obj, "created"

    changed = False
    for k, v in updates.items():
        if getattr(obj, k) != v:
            setattr(obj, k, v)
            changed = True

    return obj, ("updated" if changed else "unchanged")


def record_change(session, run_id: int, entity_type: str, entity_key: str, change_type: str, details: Optional[str] = None):
    if change_type == "unchanged":
        return
    session.add(
        ChangeEvent(
            run_id=run_id,
            entity_type=entity_type,
            entity_key=entity_key,
            change_type=change_type,
            details=details,
        )
    )


def main():
    session = get_session()
    try:
        # Start a run
        run = Run(note="seed ingest")
        session.add(run)
        session.flush()  # assigns run.id

        # Account
        account, ch = upsert(
            session,
            Account,
            identity={"name": TEST_INPUT["account"]["name"]},
            updates={},
        )
        record_change(session, run.id, "Account", account.name, ch)
        session.flush()

        # VPC
        v = TEST_INPUT["vpc"]
        vpc, ch = upsert(
            session,
            VPC,
            identity={"account_id": account.id, "provider_vpc_id": v["provider_vpc_id"]},
            updates={
                "name": v["name"],
                "cidr_block": v["cidr_block"],
                "region": v["region"],
            },
        )
        record_change(session, run.id, "VPC", f"{account.name}/{v['provider_vpc_id']}", ch)
        session.flush()

        # Subnets
        for s in TEST_INPUT["subnets"]:
            subnet, ch = upsert(
                session,
                Subnet,
                identity={"vpc_id": vpc.id, "provider_subnet_id": s["provider_subnet_id"]},
                updates={
                    "name": s["name"],
                    "cidr_block": s["cidr_block"],
                    "subnet_type": s["subnet_type"],
                },
            )
            record_change(session, run.id, "Subnet", f"{vpc.provider_vpc_id}/{s['provider_subnet_id']}", ch)

        session.commit()
        print(f"✅ Ingest complete. run_id={run.id}")

    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()

```



---

## Step 4 - Run the ingest.py script twice and verify

```text
(.venv) tsurento@Mac sot-lab % python ingest.py
✅ Ingest complete. run_id=1
(.venv) tsurento@Mac sot-lab % python ingest.py
✅ Ingest complete. run_id=2

```

At this point, you should see two `run_id` values like those shown above.

---

## Step 5 - Verify data inside DB is present and 2nd run went unchanged

```text
(.venv) user@Mac sot-lab % sqlite3 sot.db

SQLite version 3.51.0 2025-06-12 13:14:41
Enter ".help" for usage hints.
sqlite> SELECT id, run_id, entity_type, entity_key, change_type
   ...> FROM change_events
   ...> ORDER BY id;
1|1|Account|prod|created
2|1|VPC|prod/vpc-001|created
3|1|Subnet|vpc-001/subnet-001|created
4|1|Subnet|vpc-001/subnet-002|created
sqlite>
```

Verify that run 1 made changes, and run 2 did not:
```sql
sqlite> SELECT *
   ...> FROM change_events
   ...> WHERE run_id = 2;
sqlite> SELECT *
   ...> FROM change_events
   ...> WHERE run_id = 1;
1|1|Account|prod|created||2026-01-16 13:23:34.014423
2|1|VPC|prod/vpc-001|created||2026-01-16 13:23:34.015300
3|1|Subnet|vpc-001/subnet-001|created||2026-01-16 13:23:34.016646
4|1|Subnet|vpc-001/subnet-002|created||2026-01-16 13:23:34.016647
sqlite>
sqlite> .exit
```

---

## Step 6 - Change seed_data.py data and re-run

Edit `seed_data.py` and change one of the cidr_block values

```text
venv) user@Mac sot-lab % python ingest.py

✅ Ingest complete. run_id=3
(.venv) user@Mac sot-lab % sqlite3 sot.db

SQLite version 3.51.0 2025-06-12 13:14:41
Enter ".help" for usage hints.
sqlite> SELECT run_id, entity_type, entity_key, change_type
   ...> FROM change_events
   ...> WHERE run_id = 3;
3|Subnet|vpc-001/subnet-002|updated
```

---

## Step 7 - Add a tiny query script to show off importance of relationships

One huge benefit of having the SoT data stored in a database over flat JSON/YML files is that you can have relationships between the data. For example, you can link accounts to resources, link resources to other resources, etc.

The script below prints out subnets that are assigned/realated to a VPC:

**query.py**

```python
from sqlalchemy import select
from db import get_session
from models import VPC

def show_vpc_with_subnets(provider_vpc_id: str):
    session = get_session()
    try:
        stmt = select(VPC).where(VPC.provider_vpc_id == provider_vpc_id)
        vpc = session.execute(stmt).scalar_one()

        print(f"VPC: {vpc.name} ({vpc.cidr_block})")
        print("Subnets:")

        for subnet in vpc.subnets:
            print(f"  - {subnet.name:20} {subnet.cidr_block:18} [{subnet.subnet_type}]")

    finally:
        session.close()

if __name__ == "__main__":
    show_vpc_with_subnets("vpc-001")

```

Now run it:

```text
venv) user@Mac sot-lab % python query.py
VPC: prod-main (10.10.0.0/16)
Subnets:
  - prod-public-a        10.10.1.0/24       [public]
  - prod-private-a       10.10.12.0/24      [private]
```
