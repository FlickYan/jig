import unittest

from profiles.admin import change_domain
from profiles.api import get_profile
from profiles.app import build

USERS = [
    {"id": 1, "name": "Ada", "email": "ada@old.example"},
    {"id": 2, "name": "Bob", "email": "bob@other.example"},
]


class ProfileTest(unittest.TestCase):
    def test_a_changed_email_shows_up(self):
        store, service = build(USERS)
        service.profile(1)
        service.change_email(1, "ada@new.example")
        self.assertEqual(service.profile(1)["email"], "ada@new.example")
        self.assertEqual(get_profile(service, 1)["display"], "Ada <ada@new.example>")

    def test_the_domain_migration_shows_up(self):
        store, service = build(USERS)
        service.profile(1)
        service.profile(2)
        self.assertEqual(change_domain(store, "old.example", "new.example"), 1)
        self.assertEqual(service.profile(1)["email"], "ada@new.example")
        self.assertEqual(service.profile(2)["email"], "bob@other.example")

    def test_profiles_are_still_cached(self):
        store, service = build(USERS)
        for _ in range(3):
            service.profile(1)
        self.assertEqual(store.reads, 1)
        service.change_email(2, "bob@new.example")
        service.profile(1)
        self.assertEqual(store.reads, 1, "a change to another user must not make user 1 be read again")


if __name__ == "__main__":
    unittest.main()
