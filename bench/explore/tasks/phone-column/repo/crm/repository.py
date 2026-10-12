from crm.models import Customer

COLUMNS = "id, name, email"


def save(conn, customer):
    """Inserts a new customer and returns it with its id."""
    cursor = conn.execute("INSERT INTO customers (name, email) VALUES (?, ?)", (customer.name, customer.email))
    conn.commit()
    return Customer(cursor.lastrowid, customer.name, customer.email)


def get(conn, customer_id):
    row = conn.execute(f"SELECT {COLUMNS} FROM customers WHERE id = ?", (customer_id,)).fetchone()
    return Customer(*row) if row else None
