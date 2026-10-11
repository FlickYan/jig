import os
import subprocess
import sys
import unittest

from uploads.handler import handle_upload
from uploads.names import is_valid_name
from uploads.store import Store, Upload

CORPUS = [('\n\n', False), ('\n\n.png', False), ('\n .!', False), ('\n!-csvcsv', False), ('\n!a.png!Z9', False), ('\n-\n.jpg', False), ('\n..B_.a', False), ('\n.a.jpg-a', False), ('\n.png!jsonZ9', False), ('\n.pngB', False), ('\n7.png.é', False), ('\nBcsvtxtcsvZ9', False), ('\nBéB', False), ('\nZ9', False), ('\nZ9Z9_.7', False), ('\n_', False), ('\n__\n Z9', False), ('\ncsv!\n!', False), ('\ncsvZ9', False), ('\njson!', False), ('\njson.json', False), ('\ntxta', False), ('\né\njson', False), (' ', False), (' \n', False), (' \n-.jpg..jpg', False), ('  jsoné! ', False), (' !csvB! ', False), (' -', False), (' -ajson', False), (' .-json', False), (' ..jpg-', False), (' .jpg.B', False), (' .jpg.csv.jpg', False), (' .png', False), (' 7!Z9', False), (' 7.png.png.jpgé', False), (' a', False), (' csvé.png', False), (' jsona..7\n', False), (' txtZ9', False), (' é', False), ('!', False), ('!\n...', False), ('!!B..', False), ('!-', False), ('!-B.. ', False), ('!.', False), ('!.!éjson', False), ('!.jpg-', False), ('!.jpg.png.pngcsv.', False), ('!.jpg7', False), ('!.pnga', False), ('!.pngtxt', False), ('!B', False), ('!Z9csv7json', False), ('!csv-', False), ('!csv.png', False), ('!jsonZ9', False), ('!txt.Z9\né', False), ('!é7Z9 ', False), ('!é_csv', False), ('-', False), ('-\n', False), ('-\n....\nZ9', False), ('-\nZ9.jpg\n', False), ('- txt.pngjson.', False), ('---', False), ('--- .png', False), ('-..', False), ('-.._.jpgtxta', False), ('-.._csvcsv', False), ('-.Z9.pngtxta', False), ('-.jpg.png-', False), ('-.txtcsv_', False), ('-B.png', False), ('-Z9\n', False), ('-Z9\n-', False), ('-_', False), ('-_a\n', False), ('-a_.png', False), ('-json.pngcsvtxt', False), ('-txt.png-a', False), ('-é!jsonjson', False), ('.', False), ('.\n....7é', False), ('. ', False), ('..', False), ('..\n_.jpg-csv', False), ('...\njson é', False), ('...Ba', False), ('...jpg', False), ('...jpgé', False), ('...png', False), ('...png.7', False), ('..7', False), ('..7!7é_', False), ('..7a..csv', False), ('..7é', False), ('..B  csv..', False), ('..B!', False), ('..Z9.png..a ', False), ('..Z9json._csv', False), ('..Z9txt!', False), ('.._', False), ('..jpg-.', False), ('..jpgcsv', False), ('..png', False), ('..pngjson!B', False), ('..txt\n', False), ('..txt\nZ9', False), ('..txtjsoncsv', False), ('..é-', False), ('..écsv.jpgBa', False), ('.7.jpg ', False), ('.B', False), ('.B.jpg', False), ('.Z9Z9jsonB', False), ('.__.', False), ('.a -_\n', False), ('.acsv-', False), ('.csvZ9', False), ('.csv_77_', False), ('.jpg', False), ('.jpg\n.\n', False), ('.jpg\néjson.jpga', False), ('.jpg!-B ', False), ('.jpg- csv.png-', False), ('.jpg-.jpg_', False), ('.jpg-a.._txt', False), ('.jpg.', False), ('.jpg..', False), ('.jpg..jpg7', False), ('.jpg.jpg!', False), ('.jpgZ9 ', False), ('.jpga\n_B', False), ('.jpgcsvZ9txt', False), ('.jpgjson! json', False), ('.jpgjson!!csv..', False), ('.jpgtxt', False), ('.jpgtxtcsv- -', False), ('.jpgétxt.jpg \n', False), ('.png', False), ('.png\n!.é.png', False), ('.png -', False), ('.png!', False), ('.png..csv', False), ('.png._.!json', False), ('.png.png..', False), ('.png.png7BZ9Z9', False), ('.png.png_.png', False), ('.pngBtxt\n', False), ('.pngZ9Z9a..7', False), ('.png_-.jpg', False), ('.png_-json.pngé', False), ('.pngajson', False), ('.pngaé!é..', False), ('.pngcsv', False), ('.pngcsv\n', False), ('.pngcsv-.jpg', False), ('.txt..  ', False), ('.txt.png', False), ('.éZ9..', False), ('7', False), ('7\nB- txt', False), ('7 _..', False), ('7 a!_', False), ('7 txtB', False), ('7!BZ9..json', False), ('7!_é.pngZ9', False), ('7-.jpgtxt', False), ('7-7csv.pngB', False), ('7-json', False), ('7..', False), ('7..csv', True), ('7..txt ', False), ('7.B.pngacsv', False), ('7.jpg!', False), ('77json.jpg7a', False), ('7B', False), ('7Ba!', False), ('7Z9\njsonjsoncsv', False), ('7Z9--a.png', False), ('7_', False), ('7a.Z9B..', False), ('7a_', False), ('7é', False), ('7écsv..jsoncsv', False), ('7étxté_a', False), ('B', False), ('B\n.png', False), ('B!json ', False), ('B..', False), ('B.txt', True), ('B.txt_', False), ('B7Z9Z9', False), ('BB', False), ('BBjsonjson.jpg', True), ('BZ97-', False), ('B_B..', False), ('Ba', False), ('Bcsv ', False), ('BjsonjsonZ9', False), ('Bjsontxttxt7 ', False), ('Btxt\n!\ntxt', False), ('Btxt\nB\n..', False), ('BtxtB\ntxt', False), ('Bé.-a', False), ('Bé.png ', False), ('Z9', False), ('Z9\n!é', False), ('Z9\n-Z9', False), ('Z9 éBa..', False), ('Z9!.jpg!', False), ('Z9-..Z9!B', False), ('Z9-.png_json', False), ('Z9.', False), ('Z9.jpg ...jpg..', False), ('Z9.jpg json', False), ('Z9.png-', False), ('Z9.png.jpgtxt7.png', True), ('Z9Z9B', False), ('Z9_!', False), ('Z9_.png', True), ('Z9aZ9Z9txt7', False), ('Z9csv\n ', False), ('Z9é!Z9..png', False), ('Z9étxtBjson', False), ('_', False), ('_\n\n', False), ('_\n ', False), ('_\n!', False), ('_ a..', False), ('_!', False), ('_!Z9', False), ('_.jpg-', False), ('_.jpg_Z9B', False), ('_.jpgé.png.', False), ('_.pngZ9.txt', False), ('_7B7.jpg ', False), ('_B', False), ('_Z9', False), ('__', False), ('_a', False), ('_json!..', False), ('_txt', False), ('_txt_Z9\na', False), ('_éé_.', False), ('a', False), ('a!Z9json', False), ('a!csvjson.png.jpg', False), ('a-txt...Z9', False), ('a.-', False), ('a.....', False), ('a.Ba ', False), ('a.csvZ9', False), ('a.jpgtxt ', False), ('a7', False), ('a7 ', False), ('aBZ9..', False), ('a_', False), ('aa_Z9_', False), ('ajson.jpgtxt', False), ('aé', False), ('csv', False), ('csv !-', False), ('csv .jpg', True), ('csv .pngacsv', False), ('csv!', False), ('csv-Z9!!', False), ('csv..é.. .jpg', False), ('csv.Z9', False), ('csvB.jpg', True), ('csvZ9.png.jpg', True), ('csv_B.jpg.jpg', True), ('csva', False), ('csvjson.png', True), ('csvtxtZ9!.jpg', False), ('json', False), ('json\n .png.', False), ('json\na_\nB', False), ('json ', False), ('json  Z9 B', False), ('json!é', False), ('json-.png__', False), ('json-.pngjson', False), ('json..', False), ('json.jpg_ .jpg', False), ('json.jpga', False), ('json.jpgéB', False), ('json.png..', False), ('json7!..', False), ('jsonZ9a', False), ('jsoncsvtxt-B', False), ('jsoncsvéé.jpg', False), ('jsontxta!', False), ('txt', False), ('txt ....\n', False), ('txt csv', False), ('txt--B.jpg.', False), ('txt-..!', False), ('txt.', False), ('txt..', False), ('txt...jpg-', False), ('txt.jpgacsv.', False), ('txt.pngé', False), ('txt7!..', False), ('txtZ97..a', False), ('txta', False), ('txtcsvtxt.jpg.', False), ('txtjson', False), ('txttxt', False), ('txtéjson', False), ('é', False), ('é\n..', False), ('é\n.jpg.png', False), ('é ..\nB', False), ('é--.jpg.jpgtxt', False), ('é-BB', False), ('é..', False), ('é..é..B', False), ('é.a', False), ('é.jpgB', False), ('é.png', False), ('é.png ', False), ('é.png7.json', False), ('é.pngé.png-', False), ('é7', False), ('é7\nZ9txt', False), ('éB!\n', False), ('éB-.jpg_', False), ('éB...jpga', False), ('éZ9.jpg_csva', False), ('éZ9éé', False), ('éa', False), ('écsv', False), ('écsvjson', False), ('éjson.pngjson_', False), ('éjsonatxt csv', False), ('étxt.png', False), ('ééB', False), ('a.txt', True), ('a.txt\n', True), ('a..txt', True), ('a__b.txt', False), ('-a.txt', False), ('.txt', False), ('a.TXT', False), ('my report.csv', True), ('a.csv.txt', True), ('a.png ', False), ('data_2024-03.json', True), ('x y z.jpg', True), ('a .txt', True), ('a. .txt', False), ('a.b.c.png', True), ('photo.jpeg', False), ('über.txt', False), ('a\n.txt', False), ('a.txt\n\n', False), ('', False), ('a', False), ('1.jpg', True), ('a--b.csv', False), ('a-_b.csv', False)]
SLOW = ['scan 20240311 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011.pdf', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '00000000000000000000000000000000000000000000000000.pdf', 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x..exe', 'Report 2024 Report 2024 Report 2024 Report 2024 Report 2024 Report 2024 .docx', 'IMG12345678901234567890123456789012345678901234567890.jpg.bak']


def run_in_time(code, seconds):
    """Runs Python code in the project, in a process of its own, and fails if it takes longer."""
    try:
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=seconds, env={**os.environ, "PYTHONPATH": "."})
    except subprocess.TimeoutExpired:
        raise AssertionError(f"took more than {seconds} seconds") from None
    if done.returncode:
        raise AssertionError(done.stderr[-2000:])
    return done.stdout.strip()


class TestIssue(unittest.TestCase):
    def test_long_names_are_rejected_at_once(self):
        for name in SLOW:
            with self.subTest(name=name):
                self.assertEqual(run_in_time(f"from uploads.names import is_valid_name; print(is_valid_name({name!r}))", 5), "False")

    def test_the_handler_rejects_them_at_once(self):
        code = (
            "from uploads.handler import handle_upload; from uploads.store import Store; "
            f"print(handle_upload(Store(), {{'name': {SLOW[0]!r}, 'size': 10, 'owner': 'scanner'}})['status'])"
        )
        self.assertEqual(run_in_time(code, 5), "rejected")

    def test_the_same_names_are_accepted(self):
        for name, accepted in CORPUS:
            with self.subTest(name=name):
                self.assertEqual(is_valid_name(name), accepted)

    def test_listing_100000_uploads_is_quick(self):
        code = (
            "from uploads.store import Store, Upload; s = Store(); "
            "[s.add(Upload(f'file{i % 60000:05d}.txt', 1, 'x')) for i in range(100000)]; "
            "names = s.names(); print(len(names), names[0], names[-1])"
        )
        self.assertEqual(run_in_time(code, 10), "60000 file00000.txt file59999.txt")

    def test_the_list_is_the_same(self):
        store = Store()
        for name in ["b.txt", "a.csv", "b.txt", "C.png", "a.csv", "a b.txt"]:
            store.add(Upload(name, 1, "x"))
        self.assertEqual(store.names(), ["C.png", "a b.txt", "a.csv", "b.txt"])
        self.assertEqual(Store().names(), [])


class TestUnchanged(unittest.TestCase):
    def test_uploads(self):
        store = Store()
        self.assertEqual(handle_upload(store, {"name": "a.txt", "size": 5, "owner": "ada"}), {"status": "ok", "limit": 10 * 1024 * 1024})
        self.assertEqual(handle_upload(store, {"name": "b.txt", "size": 7, "owner": "bob"})["status"], "ok")
        self.assertEqual(handle_upload(store, {"name": "c.txt", "owner": "bob"}), {"status": "rejected", "reason": "missing size"})
        self.assertEqual(handle_upload(store, {"name": "c.txt", "size": 0, "owner": "bob"})["status"], "rejected")
        self.assertEqual(handle_upload(store, {"name": "c.exe", "size": 1, "owner": "bob"})["reason"], "invalid name: 'c.exe'")
        self.assertEqual((store.total_size(), [u.name for u in store.by_owner("bob")]), (12, ["b.txt"]))


if __name__ == "__main__":
    unittest.main()
