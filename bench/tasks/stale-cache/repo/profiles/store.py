class UserStore:
    """Stands in for the users table. It is slow, and `reads` counts the queries made to it."""

    def __init__(self, users):
        self._users = {user["id"]: dict(user) for user in users}
        self.reads = 0

    def get(self, user_id):
        self.reads += 1
        user = self._users.get(user_id)
        return dict(user) if user else None

    def all_ids(self):
        return list(self._users)

    def set_email(self, user_id, email):
        self._users[user_id]["email"] = email
