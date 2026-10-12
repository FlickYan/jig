from crm.models import Customer

COLUMNS = "id, name, email, phone"


def save(conn, customer):
    """Inserts a new customer and returns it with its id."""
    cursor = conn.execute("INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)", (customer.name, customer.email, customer.phone))
    conn.commit()
    return Customer(cursor.lastrowid, customer.name, customer.email, customer.phone)


def get(conn, customer_id):
    row = conn.execute(f"SELECT {COLUMNS} FROM customers WHERE id = ?", (customer_id,)).fetchone()
    return Customer(*row) if row else None
