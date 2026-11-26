; What the Windows installer adds to the registry, for this account only.
;
; EtherPK is offered for Markdown files under "Open with". It never becomes the program that opens
; them: that stays with whatever the person has, until they choose otherwise.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\EtherPK.Markdown" "" "Markdown document"
  WriteRegStr HKCU "Software\Classes\EtherPK.Markdown\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\EtherPK.Markdown\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "EtherPK.Markdown" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "EtherPK.Markdown" ""

  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "EtherPK"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".markdown" ""

  ; etherpk: links, as a task reference writes them.
  WriteRegStr HKCU "Software\Classes\etherpk" "" "URL:EtherPK link"
  WriteRegStr HKCU "Software\Classes\etherpk" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\etherpk\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\etherpk\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; An update runs the old version's uninstaller, and the new version has written these already or will.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\EtherPK.Markdown"
    DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "EtherPK.Markdown"
    DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "EtherPK.Markdown"
    DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
    DeleteRegKey HKCU "Software\Classes\etherpk"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${endIf}
!macroend

; Waits until EtherPK is closed, in place of the builder's own check, which ends the program at once and
; with it what was typed a moment ago. Windows lets no one write to a program that is running, which is
; how it is known to be.
!macro customCheckAppRunning
  !define CHECK_ID ${__LINE__}
  StrCpy $R9 0
  etherpk_check_${CHECK_ID}:
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    FileOpen $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    ${if} ${Errors}
      ; An update starts as the app closes, and the app may be saving: 30 seconds, then ask.
      ${if} $R9 < 60
        IntOp $R9 $R9 + 1
        Sleep 500
        ${if} ${isUpdated}
          Goto etherpk_check_${CHECK_ID}
        ${endIf}
        ${if} $R9 < 4
          Goto etherpk_check_${CHECK_ID}
        ${endIf}
      ${endIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "EtherPK is open. Close EtherPK, then choose Retry." /SD IDCANCEL IDRETRY etherpk_check_${CHECK_ID}
      SetErrorLevel 2
      Quit
    ${else}
      FileClose $R8
    ${endIf}
  ${endIf}
  !undef CHECK_ID
!macroend
