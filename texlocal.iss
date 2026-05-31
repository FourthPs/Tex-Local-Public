; ============================================================
;  TexLocal - Inno Setup installer (v4.1.0 Phase 3)
; ============================================================
;
;  Build:    open this file in Inno Setup IDE -> Build -> Compile
;            (or `iscc texlocal.iss` from cmd if iscc is on PATH)
;  Output:   D:\texlocal\dist\TexLocal-Setup.exe  (single double-clickable installer)
;
;  Prerequisites BEFORE compiling this .iss:
;    0. (v4.3.0) texlocal.spec now bundles BOTH templates\ AND static\ into
;       the PyInstaller build. If you edit the spec, never drop the
;       ('static','static') datas entry or the frozen app serves a blank
;       editor (editor.css / editor.js 404).
;    1. `pyinstaller texlocal.spec` has been run -> dist\TexLocal\ exists
;    2. MiKTeX-portable has been extracted to dist\TexLocal\miktex\
;       (Pol's step - see HANDOFF section 7, "Phase 3b documentation")
;    3. (Optional) MicrosoftEdgeWebview2Setup.exe placed in installer-assets\
;       for WebView2 bootstrap fallback on older Win10 machines
;
;  Install target:
;    Per-user, no admin required: %LOCALAPPDATA%\Programs\TexLocal\
;    This matches Discord / VSCode-User / Postman conventions and avoids the
;    UAC prompt that would otherwise gate every install. The trade-off is one
;    install per Windows account on a shared machine - acceptable for a
;    5-20 person lab where everyone has their own laptop.

#define MyAppName       "TexLocal"
#define MyAppVersion    "4.3.0"
#define MyAppPublisher  "PoL"
#define MyAppURL        "https://github.com/FourthPs/Tex-Local"
#define MyAppExeName    "TexLocal.exe"

[Setup]
; AppId: a unique GUID identifying this app to Windows' uninstaller registry.
; DO NOT change between versions - Windows would treat each version as a
; different app and leave orphaned uninstall entries. Generated once, lives
; forever in this file.
AppId={{A1B2C3D4-7E5F-4A8B-9C0D-1E2F3A4B5C6D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}

; Per-user install: %LOCALAPPDATA%\Programs\TexLocal\
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; ^ lets advanced users override to "for all users" if they want; default
;   stays per-user/no-admin.

OutputDir=dist
OutputBaseFilename=TexLocal-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
; ^ aggressive compression - MiKTeX has lots of redundant .tex / .sty / .pdf
;   text files, lzma2/ultra64 typically shrinks the payload 50-65%.

WizardStyle=modern
DisableProgramGroupPage=auto
DisableReadyPage=no
UninstallDisplayIcon={app}\{#MyAppExeName}
; v4.1.3-phase3 — branded installer icon. Same .ico as PyInstaller uses for
; the app exe. Make sure `python make_icon.py` was run before `iscc`.
SetupIconFile=texlocal.ico

; Minimum target: Windows 10 1809 (WebView2-ready, also matches PyWebView's reqs)
MinVersion=10.0.17763

; v4.2.0-phase4 — auto-update flow ergonomics
; - CloseApplications=yes: if TexLocal is running when the installer starts,
;   Inno asks to close it (belt-and-braces; the /api/update/apply endpoint
;   already exits TexLocal before launching this installer, but if the user
;   manually re-launches TexLocal during the wizard, this catches it).
; - RestartApplications=yes: after install, Inno re-launches whatever it
;   closed. So a user who updates from inside TexLocal sees the new
;   TexLocal come up automatically when the wizard finishes.
CloseApplications=yes
RestartApplications=yes

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
; Thai locale not pre-bundled with Inno; add later if Pol wants Thai-language wizard:
; Name: "thai"; MessagesFile: "compiler:Languages\Thai.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; \
    GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
; ^ unchecked default - many users dislike installer-added desktop icons.
;   Tick the box in the wizard if you want one.

[Files]
; PyInstaller dist output - everything in dist\TexLocal\ ends up in {app}\
Source: "dist\TexLocal\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; MiKTeX-portable bundle. Extract MiKTeX-portable to D:\texlocal\miktex\
; BEFORE compiling the installer.
;
; v4.1.4-phase3 changes:
;   1. Source path moved from `dist\TexLocal\miktex\*` to `miktex\*` so
;      PyInstaller's --noconfirm wipe of dist/TexLocal/ can never touch
;      the manually-provided MiKTeX bundle.
;   2. REMOVED `skipifsourcedoesntexist` flag. If MiKTeX is missing, we
;      WANT iscc to fail loudly with "No files found matching ..." rather
;      than silently shipping a 200MB installer with no MiKTeX. The
;      previous silent skip was the root cause of 3 patch loops
;      (v4.1.1, v4.1.2, v4.1.3 all looked successful but produced
;      broken installers).
;   3. Source pattern broadened from `miktex\*` to `miktex\*` with
;      recursesubdirs - same syntax but verified that even with 0 top-
;      level files (miktex/ contains only `texmfs/` subdirectory), Inno
;      will descend and collect everything underneath.
Source: "miktex\*"; DestDir: "{app}\miktex"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; v4.1.6-phase3 — Debug Mode launcher. Sets TEXLOCAL_DEBUG=1 before launching
; TexLocal.exe so _inject_bundled_miktex() and the compile run() helper write
; their diagnostic info to miktex-inject-debug.log. Paired with the second
; Start Menu shortcut in [Icons].
Source: "TexLocal-Debug.bat"; DestDir: "{app}"; Flags: ignoreversion

; WebView2 bootstrapper - optional. Place in installer-assets\ if you want
; the installer to offer to install WebView2 runtime when missing.
Source: "installer-assets\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; \
    Flags: deleteafterinstall skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

; v4.1.6-phase3 — Debug Mode shortcut. Same icon as main app but launches via
; TexLocal-Debug.bat (which sets TEXLOCAL_DEBUG=1 first). Tell users to use
; this when reporting compile bugs — log appears at {app}\miktex-inject-debug.log
; after they reproduce the issue.
Name: "{group}\{#MyAppName} (Debug Mode)"; Filename: "{app}\TexLocal-Debug.bat"; \
    IconFilename: "{app}\{#MyAppExeName}"; \
    Comment: "Launch with diagnostic logging enabled (for bug reports)"

Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; \
    Tasks: desktopicon

[Run]
; If WebView2 bootstrapper was bundled AND runtime is missing, install it
; silently before launching TexLocal for the first time.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; \
    Parameters: "/silent /install"; \
    Flags: waituntilterminated runhidden skipifdoesntexist; \
    Check: not WebView2RuntimeInstalled

; Offer to launch TexLocal after install finishes
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up MiKTeX's runtime data dir on uninstall. {app}\miktex contains both
; the static install (texmfs/install/) AND the user-cache (texmfs/data/, grows
; with auto-installed packages). Inno only removes files it placed, so the
; auto-fetched cache would orphan. This forces full cleanup.
Type: filesandordirs; Name: "{app}\miktex"

; Per-user projects/ stays - users will be unhappy if uninstall nukes their work.
; To remove: manual delete of {app}\projects\.

[Code]
// Detect WebView2 runtime. Modern Windows has a per-machine and per-user
// install option; check both registry locations.
function WebView2RuntimeInstalled(): Boolean;
var
  Version: string;
begin
  Result := False;
  // 64-bit per-machine
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    if (Version <> '') and (Version <> '0.0.0.0') then
      Result := True;
  // Per-user
  if not Result then
    if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
      if (Version <> '') and (Version <> '0.0.0.0') then
        Result := True;
end;

// v4.1.1-phase3 — REMOVED InitializeSetup() sanity check that wrongly ran on
// end-user machines. The original intent was "warn the developer if they
// forgot to run pyinstaller before iscc" — but InitializeSetup() runs when
// the INSTALLER is executed (i.e. on the end-user's machine), not at
// compile time. On the end-user's machine `{src}` is wherever they put the
// installer (Desktop, Downloads, USB stick), not D:\texlocal\, so the
// check always false-negative'd and aborted install with a confusing error.
// Compile-time validation of source files already happens via [Files]
// section processing — Inno fails at build time if dist\TexLocal\ is empty.
