#!/usr/bin/env python3
import argparse
import cgi
import json
import os
import shutil
import sqlite3
import tempfile
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from import_data import import_csv


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PUBLIC = os.path.join(ROOT, "public")

SORT_COLUMNS = {
    "lg_st_code",
    "state",
    "lg_dt_code",
    "district",
    "pincode",
    "registration_date",
    "enterprise_name",
    "activities",
}


def json_response(handler, status, payload):
    if isinstance(payload, str):
        body = payload.encode("utf-8")
    elif isinstance(payload, (bytes, bytearray)):
        body = bytes(payload)
    else:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def get_first(query, key, default=""):
    return (query.get(key, [default])[0] or "").strip()


def like(value):
    return f"%{value}%"


def fts_query(value):
    terms = [term.replace('"', "") for term in value.split() if term.strip()]
    return " ".join(f'"{term}"*' for term in terms)


class ExplorerHandler(SimpleHTTPRequestHandler):
    db_path = ""
    import_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args))

    def db(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        conn.execute("PRAGMA temp_store = MEMORY")
        return conn

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/records":
            return self.records(parse_qs(parsed.query))
        if parsed.path == "/api/meta":
            return self.meta(parse_qs(parsed.query))
        if parsed.path.startswith("/api/records/"):
            return self.record_detail(parsed.path.rsplit("/", 1)[-1])
        if parsed.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/import":
            return self.import_upload()
        return json_response(self, 404, {"error": "Not found"})

    def build_filters(self, query):
        where = []
        params = []
        search = get_first(query, "q")
        use_fts = False

        text_filters = {
            "enterprise_name": "e.enterprise_name",
            "activities": "e.activities",
        }

        for key, column in text_filters.items():
            value = get_first(query, key)
            if value:
                where.append(f"{column} LIKE ?")
                params.append(like(value))

        if search:
            try:
                with self.db() as conn:
                    conn.execute("SELECT rowid FROM enterprises_fts LIMIT 1").fetchone()
                use_fts = True
                where.append("e.id IN (SELECT rowid FROM enterprises_fts WHERE enterprises_fts MATCH ?)")
                params.append(fts_query(search))
            except sqlite3.OperationalError:
                where.append(
                    "(e.enterprise_name LIKE ? OR e.communication_address LIKE ? OR e.activities LIKE ?)"
                )
                params.extend([like(search), like(search), like(search)])

        equals = [
            ("state", "state"),
            ("district", "district"),
            ("pincode", "pincode"),
            ("lg_st_code", "lg_st_code"),
            ("lg_dt_code", "lg_dt_code"),
        ]
        for key, column in equals:
            value = get_first(query, key)
            if value:
                where.append(f"e.{column} = ?")
                params.append(value)

        date_from = get_first(query, "date_from")
        date_to = get_first(query, "date_to")
        if date_from:
            where.append("e.registration_date >= ?")
            params.append(date_from)
        if date_to:
            where.append("e.registration_date <= ?")
            params.append(date_to)

        clause = " WHERE " + " AND ".join(where) if where else ""
        return clause, params, use_fts

    def records(self, query):
        page = max(1, int(get_first(query, "page", "1") or "1"))
        per_page = min(100, max(10, int(get_first(query, "per_page", "50") or "50")))
        sort = get_first(query, "sort", "enterprise_name")
        direction = get_first(query, "direction", "asc").lower()
        if sort not in SORT_COLUMNS:
            sort = "enterprise_name"
        if direction not in {"asc", "desc"}:
            direction = "asc"

        where, params, _ = self.build_filters(query)
        offset = (page - 1) * per_page

        with self.db() as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM enterprises e{where}", params).fetchone()[0]
            rows = conn.execute(
                f"""
                SELECT id, lg_st_code, state, lg_dt_code, district, pincode, registration_date,
                       enterprise_name, communication_address, activities
                FROM enterprises e
                {where}
                ORDER BY e.{sort} COLLATE NOCASE {direction}, e.id ASC
                LIMIT ? OFFSET ?
                """,
                params + [per_page, offset],
            ).fetchall()

        json_response(
            self,
            200,
            {
                "rows": [dict(row) for row in rows],
                "page": page,
                "perPage": per_page,
                "total": total,
                "pages": max(1, (total + per_page - 1) // per_page),
            },
        )

    def meta(self, query):
        state = get_first(query, "state")
        with self.db() as conn:
            total = conn.execute("SELECT COUNT(*) FROM enterprises").fetchone()[0]
            states = [
                row[0]
                for row in conn.execute(
                    "SELECT DISTINCT state FROM enterprises WHERE state IS NOT NULL ORDER BY state"
                ).fetchall()
            ]
            if state:
                districts = [
                    row[0]
                    for row in conn.execute(
                        """
                        SELECT DISTINCT district FROM enterprises
                        WHERE district IS NOT NULL AND state = ?
                        ORDER BY district
                        """,
                        [state],
                    ).fetchall()
                ]
            else:
                districts = [
                    row[0]
                    for row in conn.execute(
                        """
                        SELECT DISTINCT district FROM enterprises
                        WHERE district IS NOT NULL
                        ORDER BY district
                        LIMIT 500
                        """
                    ).fetchall()
                ]
        json_response(self, 200, {"total": total, "states": states, "districts": districts})

    def record_detail(self, raw_id):
        try:
            record_id = int(raw_id)
        except ValueError:
            return json_response(self, 400, {"error": "Invalid record id"})
        with self.db() as conn:
            row = conn.execute("SELECT * FROM enterprises WHERE id = ?", [record_id]).fetchone()
        if not row:
            return json_response(self, 404, {"error": "Record not found"})
        json_response(self, 200, {"record": dict(row)})

    def import_upload(self):
        if not self.import_lock.acquire(blocking=False):
            return json_response(self, 409, {"error": "An import is already running"})

        temp_path = None
        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
                },
            )
            if "csv" not in form:
                return json_response(self, 400, {"error": "Missing CSV file"})

            file_item = form["csv"]
            if not getattr(file_item, "file", None):
                return json_response(self, 400, {"error": "Invalid CSV upload"})

            os.makedirs(os.path.join(ROOT, "uploads"), exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=os.path.join(ROOT, "uploads"),
                prefix="upload-",
                suffix=".csv",
                delete=False,
            ) as temp:
                temp_path = temp.name
                shutil.copyfileobj(file_item.file, temp)

            stats = import_csv(temp_path, self.db_path, replace=True)
            return json_response(self, 200, {"ok": True, "stats": stats})
        except ValueError as exc:
            return json_response(self, 400, {"error": str(exc)})
        except Exception as exc:
            return json_response(self, 500, {"error": f"Import failed: {exc}"})
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
            self.import_lock.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(ROOT, "data", "enterprise.db"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.exists(db_path):
        raise SystemExit(f"Database not found: {db_path}\nRun: npm run import-data")

    ExplorerHandler.db_path = db_path
    server = ThreadingHTTPServer((args.host, args.port), ExplorerHandler)
    print(f"Enterprise Data Explorer running at http://{args.host}:{args.port}")
    print(f"Database: {db_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")


if __name__ == "__main__":
    main()
