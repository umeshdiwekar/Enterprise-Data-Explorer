#!/usr/bin/env python3
import csv
import hashlib
import os
import sqlite3
import sys
from datetime import datetime


EXPECTED_COLUMNS = [
    "LG_ST_Code",
    "State",
    "LG_DT_Code",
    "District",
    "Pincode",
    "RegistrationDate",
    "EnterpriseName",
    "CommunicationAddress",
    "Activities",
]

BATCH_SIZE = 2000


def clean_text(value):
    value = (value or "").strip()
    return value or None


def clean_code(value):
    value = clean_text(value)
    if not value:
        return None
    if value.endswith(".0"):
        value = value[:-2]
    return value


def clean_pincode(value):
    value = clean_code(value)
    if not value:
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or value


def parse_date(value):
    value = clean_text(value)
    if not value:
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def content_hash(row):
    raw = "\x1f".join(row.get(col, "") or "" for col in EXPECTED_COLUMNS)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def connect(db_path):
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -200000")
    return conn


def reset_schema(conn):
    conn.executescript(
        """
        DROP TABLE IF EXISTS enterprises_fts;
        DROP TABLE IF EXISTS enterprises;
        """
    )


def create_schema(conn):
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(enterprises)").fetchall()
    }
    if existing_columns and "source_row" not in existing_columns:
        conn.executescript(
            """
            DROP TABLE IF EXISTS enterprises_fts;
            DROP TABLE IF EXISTS enterprises;
            """
        )

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS enterprises (
            id INTEGER PRIMARY KEY,
            source_row INTEGER NOT NULL UNIQUE,
            lg_st_code TEXT,
            state TEXT,
            lg_dt_code TEXT,
            district TEXT,
            pincode TEXT,
            registration_date TEXT,
            enterprise_name TEXT,
            communication_address TEXT,
            activities TEXT,
            content_hash TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_enterprises_state ON enterprises(state);
        CREATE INDEX IF NOT EXISTS idx_enterprises_district ON enterprises(district);
        CREATE INDEX IF NOT EXISTS idx_enterprises_pincode ON enterprises(pincode);
        CREATE INDEX IF NOT EXISTS idx_enterprises_registration_date ON enterprises(registration_date);
        CREATE INDEX IF NOT EXISTS idx_enterprises_lg_st_code ON enterprises(lg_st_code);
        CREATE INDEX IF NOT EXISTS idx_enterprises_lg_dt_code ON enterprises(lg_dt_code);
        CREATE INDEX IF NOT EXISTS idx_enterprises_state_district ON enterprises(state, district);
        """
    )
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS enterprises_fts
            USING fts5(enterprise_name, communication_address, activities, content='enterprises', content_rowid='id')
            """
        )
    except sqlite3.OperationalError as exc:
        print(f"warning: SQLite FTS5 unavailable, search API will use LIKE fallback ({exc})")


def validate_header(reader):
    if reader.fieldnames != EXPECTED_COLUMNS:
        expected = ", ".join(EXPECTED_COLUMNS)
        found = ", ".join(reader.fieldnames or [])
        raise ValueError(f"CSV header mismatch. Expected: {expected}. Found: {found}")


def row_values(source_row, row):
    return (
        source_row,
        clean_code(row["LG_ST_Code"]),
        clean_text(row["State"]),
        clean_code(row["LG_DT_Code"]),
        clean_text(row["District"]),
        clean_pincode(row["Pincode"]),
        parse_date(row["RegistrationDate"]),
        clean_text(row["EnterpriseName"]),
        clean_text(row["CommunicationAddress"]),
        clean_text(row["Activities"]),
        content_hash(row),
    )


def flush(conn, batch):
    before = conn.total_changes
    conn.executemany(
        """
        INSERT OR IGNORE INTO enterprises (
            source_row, lg_st_code, state, lg_dt_code, district, pincode, registration_date,
            enterprise_name, communication_address, activities, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        batch,
    )
    return conn.total_changes - before


def rebuild_fts(conn):
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'enterprises_fts'"
    ).fetchone()
    if exists:
        conn.execute("INSERT INTO enterprises_fts(enterprises_fts) VALUES('rebuild')")


def import_csv(csv_path, db_path, replace=False):
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    conn = connect(db_path)
    if replace:
        reset_schema(conn)
    create_schema(conn)

    read_count = 0
    inserted_count = 0
    invalid_dates = 0
    batch = []

    with open(csv_path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        validate_header(reader)
        for row in reader:
            read_count += 1
            values = row_values(read_count, row)
            if row.get("RegistrationDate") and not values[6]:
                invalid_dates += 1
            batch.append(values)
            if len(batch) >= BATCH_SIZE:
                inserted_count += flush(conn, batch)
                conn.commit()
                batch.clear()
        if batch:
            inserted_count += flush(conn, batch)
            conn.commit()

    rebuild_fts(conn)
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM enterprises").fetchone()[0]
    conn.execute("PRAGMA optimize")
    conn.close()

    return {
        "csvRowsRead": read_count,
        "newRowsInserted": inserted_count,
        "duplicateRowsSkipped": read_count - inserted_count,
        "rowsInDatabase": total,
        "unparsedRegistrationDates": invalid_dates,
        "database": db_path,
    }


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "indore.csv"
    db_path = sys.argv[2] if len(sys.argv) > 2 else "data/enterprise.db"
    replace = "--replace" in sys.argv[3:]
    try:
        stats = import_csv(csv_path, db_path, replace=replace)
    except (FileNotFoundError, ValueError) as exc:
        raise SystemExit(str(exc))

    print(f"CSV rows read: {stats['csvRowsRead']}")
    print(f"New rows inserted: {stats['newRowsInserted']}")
    print(f"Duplicate rows skipped: {stats['duplicateRowsSkipped']}")
    print(f"Rows in database: {stats['rowsInDatabase']}")
    print(f"Rows with unparsed registration dates: {stats['unparsedRegistrationDates']}")
    print(f"Database: {stats['database']}")


if __name__ == "__main__":
    main()
