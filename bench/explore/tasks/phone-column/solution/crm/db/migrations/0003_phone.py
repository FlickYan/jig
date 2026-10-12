def up(conn):
    conn.execute("ALTER TABLE customers ADD COLUMN phone TEXT")


def down(conn):
    conn.execute("CREATE TABLE customers_before (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
    conn.execute("INSERT INTO customers_before (id, name, email) SELECT id, name, email FROM customers")
    conn.execute("DROP TABLE customers")
    conn.execute("ALTER TABLE customers_before RENAME TO customers")
