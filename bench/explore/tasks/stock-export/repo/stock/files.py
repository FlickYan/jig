import csv
import os

from stock import clock


def write_csv(config, command, header, rows):
    """Writes a command's CSV file and returns its path: <export dir>/<command>-<YYYYMMDD>.csv. Money
    columns hold cents; the first line names the currency they are in."""
    os.makedirs(config["export_dir"], exist_ok=True)
    path = os.path.join(config["export_dir"], f"{command}-{clock.today():%Y%m%d}.csv")
    with open(path, "w", newline="") as f:
        f.write(f"# currency: {config['currency']}\n")
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    return path
