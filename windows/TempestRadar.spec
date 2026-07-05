# PyInstaller spec for TempestRadar.exe — build from the repo root:
#   pyinstaller windows/TempestRadar.spec
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))  # noqa: F821

datas = [(os.path.join(ROOT, "static"), "static")]
datas += collect_data_files("metpy")
datas += collect_data_files("pint")  # unit registry text files metpy needs

hiddenimports = (
    collect_submodules("uvicorn")
    + ["websocket", "app", "config", "state",
       "workers.alerts", "workers.news", "workers.radar",
       "workers.level2", "workers.tempest"]
)

a = Analysis(
    [os.path.join(SPECPATH, "launcher.py")],  # noqa: F821
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="TempestRadar",
    console=False,
    upx=False,
)
