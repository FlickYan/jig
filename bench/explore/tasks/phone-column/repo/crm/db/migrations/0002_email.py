def up(conn):
    conn.execute("ALTER TABLE customers ADD COLUMN email TEXT")


def down(conn):
    conn.execute("CREATE TABLE customers_before (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    conn.execute("INSERT INTO customers_before (id, name) SELECT id, name FROM customers")
    conn.execute("DROP TABLE customers")
    conn.execute("ALTER TABLE customers_before RENAME TO customers")
