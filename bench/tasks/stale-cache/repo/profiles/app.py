"""Builds the store and the service the way the web app does."""
from profiles.service import ProfileService
from profiles.store import UserStore


def build(users):
    store = UserStore(users)
    return store, ProfileService(store)
