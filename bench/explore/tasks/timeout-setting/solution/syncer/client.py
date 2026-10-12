from syncer import settings


def fetch_page(transport, page):
    """One page of the marketplace's catalogue."""
    config = settings.load()
    return transport.get(
        f"/{config['region']}/catalogue",
        params={"page": page, "size": config["page_size"]},
        retries=config["retries"],
        timeout=config["timeout"],
    )
