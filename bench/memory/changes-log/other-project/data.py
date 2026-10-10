def getdata(path):
    with open(path) as handle:
        return handle.read().splitlines()
