"""Relocatable Fontconfig bootstrap for TexLocal's bundled MiKTeX.

MiKTeX Portable generates ``fonts.conf`` with absolute paths from the machine
and directory where the portable tree was initialized.  TexLocal's installer
relocates that tree, so using the generated file directly can make XeTeX blind
to both Windows fonts and bundled OpenType fonts.  Repair only those generated
path nodes at app startup and keep the font cache in per-user app data.
"""

from html import escape as _xml_escape
import os
import re
import tempfile


def _fontconfig_path(path):
    """Return an XML-safe, slash-normalized absolute path."""
    return _xml_escape(os.path.abspath(path).replace("\\", "/"), quote=False)


def _atomic_write_if_changed(path, content):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            if fh.read() == content:
                return False
    except OSError:
        pass

    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".texlocal-fontconfig-", suffix=".tmp",
                               dir=parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return True


_LOCAL_INCLUDE_RE = re.compile(
    r"(<include\b[^>]*>)[^<]*localfonts\.conf\s*(</include>)", re.I)
_CONF_D_INCLUDE_RE = re.compile(
    r"(<include\b[^>]*>)[^<]*[\\/]conf\.d\s*(</include>)", re.I)
_CACHE_DIR_RE = re.compile(
    r"(<cachedir\b[^>]*>)[^<]*[\\/]fontconfig[\\/]cache\s*(</cachedir>)",
    re.I)


def _replace_required(text, pattern, value, label):
    updated, count = pattern.subn(
        lambda match: match.group(1) + value + match.group(2), text, count=1)
    if count != 1:
        raise ValueError(f"MiKTeX fonts.conf has no recognizable {label}")
    return updated


def repair_portable_fontconfig(app_dir, *, environ=None, runtime_root=None):
    """Repair relocated Fontconfig paths in a bundled MiKTeX tree.

    ``app_dir`` is the directory containing ``TexLocal.exe`` and ``miktex/``.
    MiKTeX's wrappers ignore the standard ``FONTCONFIG_FILE`` override and
    force-load ``texmfs/config/fontconfig/config/fonts.conf``, so that generated
    file must point at the *current* install/user paths.  Rewrites are atomic,
    narrowly targeted, and repeated safely at every app start.  Font caches
    stay in the user's writable app-data area.  Returns the repaired config
    path, or ``None`` when the expected portable tree is absent.
    """
    env = os.environ if environ is None else environ
    texmfs = os.path.join(app_dir, "miktex", "texmfs")
    config_dir = os.path.join(texmfs, "config", "fontconfig", "config")
    fonts_conf = os.path.join(config_dir, "fonts.conf")
    localfonts_conf = os.path.join(config_dir, "localfonts.conf")
    if not (os.path.isfile(fonts_conf) and os.path.isfile(localfonts_conf)):
        return None

    local_appdata = (env.get("LOCALAPPDATA") or env.get("APPDATA")
                     or os.path.expanduser("~"))
    windows_dir = env.get("WINDIR") or env.get("SystemRoot") or r"C:\Windows"
    if runtime_root is None:
        runtime_root = os.path.join(local_appdata, "TexLocal", "fontconfig")

    cache_dir = os.path.join(runtime_root, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    user_fonts = os.path.join(local_appdata, "Microsoft", "Windows", "Fonts")
    system_fonts = os.path.join(windows_dir, "Fonts")
    bundled_fonts = os.path.join(texmfs, "install", "fonts", "opentype")
    conf_d = os.path.join(texmfs, "install", "fontconfig", "config", "conf.d")
    localfonts2 = os.path.join(texmfs, "config", "fontconfig", "config",
                               "localfonts2.conf")

    with open(fonts_conf, "r", encoding="utf-8", errors="replace") as fh:
        content = fh.read()
    content = _replace_required(
        content, _LOCAL_INCLUDE_RE, _fontconfig_path(localfonts_conf),
        "localfonts.conf include")
    content = _replace_required(
        content, _CONF_D_INCLUDE_RE, _fontconfig_path(conf_d),
        "conf.d include")
    content = _replace_required(
        content, _CACHE_DIR_RE, _fontconfig_path(cache_dir),
        "cache directory")

    # Regenerate the small machine-specific companion instead of trying to
    # recognize the build user's name or Windows directory in-place.
    local_content = """<?xml version="1.0" encoding="UTF-8"?>
<fontconfig>
  <include ignore_missing="yes">{localfonts2}</include>
  <dir>{user_fonts}</dir>
  <dir>{system_fonts}</dir>
  <dir>{bundled_fonts}</dir>
</fontconfig>
""".format(
        user_fonts=_fontconfig_path(user_fonts),
        system_fonts=_fontconfig_path(system_fonts),
        bundled_fonts=_fontconfig_path(bundled_fonts),
        localfonts2=_fontconfig_path(localfonts2),
    )

    # Publish the companion first; fonts.conf is the entry point and is exposed
    # only after everything it names exists.
    _atomic_write_if_changed(localfonts_conf, local_content)
    _atomic_write_if_changed(fonts_conf, content)
    return fonts_conf
