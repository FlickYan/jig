"""What the web handlers call."""


def get_profile(service, user_id):
    profile = dict(service.profile(user_id))
    profile["display"] = f"{profile['name']} <{profile['email']}>"
    return profile
