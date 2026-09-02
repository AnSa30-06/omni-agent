; Omni Agent - Windows installer (Inno Setup 6)
;
; Deliberately a PER-USER install into LocalAppData:
;   * no UAC prompt, so a non-admin user can install it;
;   * the app writes to its own data directory anyway;
;   * uninstall is a clean directory removal.
;
; The installer bundles Node.js and this app's own dependencies, so it works on
; a machine with nothing preinstalled. It does NOT bundle the model gateway
; (2.7 GB installed), OpenCode (514 MB) or Chromium (701 MB) - those are fetched
; on first run, with progress shown. The welcome page says so plainly rather
; than surprising the user with a 4 GB download.

#define AppName "Omni Agent"
#define AppExeName "OmniAgent.exe"
#ifndef AppVersion
  #define AppVersion "1.1.12"
#endif
#define AppPublisher "Omni Agent contributors"
#define AppURL "https://github.com/AnSa30-06/omni-agent"

[Setup]
AppId={{7C4B2E11-9A3D-4F58-B0C6-2D9E5A1F8B34}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={localappdata}\Programs\OmniAgent
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; `commandline` is load-bearing, not decoration. With `dialog` alone, Inno
; IGNORES /CURRENTUSER and /ALLUSERS and shows "Select install mode" anyway -
; which /VERYSILENT then renders invisible, so an unattended install looks
; exactly like a hang. Measured 2026-08-28 against 1.1.3.
PrivilegesRequiredOverridesAllowed=dialog commandline
OutputDir=..\dist
OutputBaseFilename=OmniAgentSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
LicenseFile=..\LICENSE
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "runsetup";    Description: "Finish setup now (downloads the model gateway and browser, about 4 GB)"; GroupDescription: "After installing:"

[Files]
; The application itself.
Source: "..\staging\app\*";  DestDir: "{app}\app";  Flags: ignoreversion recursesubdirs createallsubdirs
; A private Node.js runtime, so the machine needs nothing preinstalled.
Source: "..\staging\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
; Launcher shims.
; The application executable itself (built by scripts/build-exe.mjs).
Source: "..\staging\OmniAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "OmniAgent.cmd";     DestDir: "{app}"; Flags: ignoreversion
Source: "OmniAgentApp.cmd";  DestDir: "{app}"; Flags: ignoreversion
Source: "OmniAgentSetup.cmd";DestDir: "{app}"; Flags: ignoreversion
Source: "OmniAgentDoctor.cmd";DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md";      DestDir: "{app}"; Flags: ignoreversion

[Icons]
; A real executable, built as a Windows-subsystem binary, so it opens the app
; and never a console. IconFilename is still set because the icon cannot always
; be stamped into the exe at build time (see scripts/build-exe.mjs).
Name: "{group}\{#AppName}";              Filename: "{app}\OmniAgent.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app\installer\assets\omni-agent.ico"
; The same app, but in a visible console - the thing to run when the exe starts
; nothing and you need to see why. OmniAgent.cmd is the general CLI shim and
; takes arguments, so it is not a shortcut target.
Name: "{group}\{#AppName} in a terminal"; Filename: "{app}\OmniAgentApp.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\app\installer\assets\omni-agent.ico"
Name: "{group}\Set up {#AppName}";       Filename: "{app}\OmniAgentSetup.cmd"; WorkingDir: "{app}"
; Through a .cmd so the console stays open - run directly, node.exe closed
; the window in the same millisecond the report appeared.
Name: "{group}\Check {#AppName} health"; Filename: "{app}\OmniAgentDoctor.cmd"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}";    Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}";        Filename: "{app}\OmniAgent.exe"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\app\installer\assets\omni-agent.ico"

[Run]
Filename: "{app}\OmniAgentSetup.cmd"; Description: "Finish setup"; Flags: shellexec postinstall skipifsilent; Tasks: runsetup

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\app"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nOmni Agent is an AI assistant that can write code, browse the web, do research, fill in web forms and work with your documents.%n%nAfter installing, it downloads the model gateway and a browser engine (about 4 GB). You need an internet connection for that step, but you do NOT need an API key - it works with free models out of the box.

[Code]
// Warn about disk space before we get halfway through a 4 GB download.
function InitializeSetup(): Boolean;
var
  FreeMB: Cardinal;
  Dummy: Cardinal;
begin
  Result := True;
  if GetSpaceOnDisk(ExpandConstant('{localappdata}'), True, FreeMB, Dummy) then
  begin
    if FreeMB < 6000 then
    begin
      Result := MsgBox('Omni Agent needs about 6 GB of free disk space once fully set up,' + #13#10 +
                       'and this drive reports only ' + IntToStr(FreeMB) + ' MB free.' + #13#10#13#10 +
                       'Install anyway?', mbConfirmation, MB_YESNO) = IDYES;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\OmniAgent');
    // Only ever on an explicit Yes from a human.
    //
    // /SUPPRESSMSGBOXES makes MsgBox return the DEFAULT button without showing
    // anything, and the default for MB_YESNO is IDYES - so a silent uninstall
    // was answering "yes, delete my settings, saved API keys and downloaded
    // browser" on the user's behalf. Measured: it did exactly that, twice.
    // A prompt nobody saw is not consent, so a silent uninstall now keeps the
    // data and the user can delete the directory themselves.
    if DirExists(DataDir) and (not UninstallSilent) then
    begin
      if MsgBox('Also delete your Omni Agent settings, saved API keys, logs and downloaded browser?' + #13#10#13#10 +
                DataDir + #13#10#13#10 +
                'Choose No to keep them for a future reinstall.', mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
