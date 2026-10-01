from profiles.cache import Cache


class ProfileService:
    def __init__(self, store, cache=None):
        self.store = store
        self.cache = cache or Cache()

    def profile(self, user_id):
        """A user's public profile. Cached, because the store is slow."""
        key = f"profile:{user_id}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        user = self.store.get(user_id)
        if user is None:
            raise KeyError(user_id)
        profile = {"id": user["id"], "name": user["name"], "email": user["email"]}
        self.cache.set(key, profile)
        return profile

    def change_email(self, user_id, email):
        if "@" not in email:
            raise ValueError("invalid email address")
        self.store.set_email(user_id, email)
