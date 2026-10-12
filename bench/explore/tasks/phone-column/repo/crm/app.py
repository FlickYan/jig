from crm.db import version


def check_schema(conn):
    """The app only runs on the schema it was written for."""
    current = conn.execute("SELECT version FROM schema_version").fetchone()[0]
    if current != version.EXPECTED:
        raise RuntimeError(f"the database is at version {current}, the app needs {version.EXPECTED}: run the migrations")
