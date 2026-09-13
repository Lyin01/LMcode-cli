; Custom NSIS steps for LMCODE Desktop.
;
; The LAN remote service only works when Windows Firewall lets phones on the
; local subnet reach the app. The installer runs elevated in the common case
; (per-machine installs / "allowElevation"), so it can create the inbound rule
; up front. When the installer is not elevated the rule is skipped silently;
; the remote connect dialog offers a "one-click allow" button that requests
; elevation on demand, so nothing here is load-bearing.
;
; NOTE: keep this file ASCII-only and BOM-free. NSIS chokes on non-ASCII bytes
; in included scripts ("Bad text encoding") depending on the input charset,
; and electron-builder compiles the installer with -WX (warnings as errors).

!echo "lmcode-installer-include: active"

!include LogicLib.nsh

!define LMCODE_FIREWALL_RULE "LMCODE Desktop Remote (LAN)"

!macro lmcodeWriteFirewallRule
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "Admin"
    DetailPrint "LMCODE: adding LAN firewall rule for the remote service"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${LMCODE_FIREWALL_RULE}"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${LMCODE_FIREWALL_RULE}" dir=in action=allow program="$INSTDIR\LMCODE.exe" protocol=TCP profile=any remoteip=localsubnet'
  ${Else}
    DetailPrint "LMCODE: installer is not elevated, skipping firewall rule (the app can add it later)"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro lmcodeWriteFirewallRule
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${LMCODE_FIREWALL_RULE}"'
!macroend
