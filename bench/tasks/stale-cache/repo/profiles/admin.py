"""Tools the support team runs."""


def change_domain(store, old_domain, new_domain):
    """Move every user with an address at old_domain to new_domain. Returns how many were changed."""
    changed = 0
    for user_id in store.all_ids():
        email = store.get(user_id)["email"]
        if email.endswith("@" + old_domain):
            store.set_email(user_id, email[: -len(old_domain)] + new_domain)
            changed += 1
    return changed
