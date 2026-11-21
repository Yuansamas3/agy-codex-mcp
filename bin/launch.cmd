@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "ENTRY=%SCRIPT_DIR%..\server\index.mjs"
set "NODE_EXE="

for /f "delims=" %%I in ('where.exe node 2^>nul') do (
  if not defined NODE_EXE if exist "%%~fI" set "NODE_EXE=%%~fI"
)

if not defined NODE_EXE if defined APPDATA if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE if defined ProgramFiles if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if defined ProgramFiles^(x86^) if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if defined USERPROFILE if exist "%USERPROFILE%\.volta\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.volta\bin\node.exe"
if not defined NODE_EXE if defined USERPROFILE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\shims\node.exe"

if not defined NODE_EXE if defined APPDATA if exist "%APPDATA%\nvm" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%APPDATA%\nvm\v*" 2^>nul') do (
    if not defined NODE_EXE if exist "%APPDATA%\nvm\%%D\node.exe" set "NODE_EXE=%APPDATA%\nvm\%%D\node.exe"
  )
)

if not defined NODE_EXE (
  echo [sidedesk] Error: Node.js executable not found in PATH or standard installation directories. 1>&2
  exit /b 1
)

"%NODE_EXE%" "%ENTRY%" %*
exit /b %ERRORLEVEL%
