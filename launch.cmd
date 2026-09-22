@echo off
rem ============================================================
rem  Python Challenge Camp - launcher bootstrap
rem
rem  This file is deliberately ASCII-only. Windows cmd on a
rem  Chinese locale defaults to codepage 936 (GBK), which would
rem  garble any Chinese text written here. So this script only
rem  locates node.exe and hands over to scripts\launch.js, which
rem  prints all user-facing messages (Node uses WriteConsoleW,
rem  so Chinese renders correctly).
rem
rem  NOTE: this file MUST use CRLF line endings. Batch files with
rem  LF-only endings break on 'goto :label' and multi-line 'if ('
rem  blocks. If you edit it, keep CRLF.
rem
rem  A one-line diagnostic is always written to
rem  %TEMP%\python-camp-launch.log so failures can be traced.
rem ============================================================
setlocal
set "EXTDIR=%~dp0"
set "LOG=%TEMP%\python-camp-launch.log"
set "NODE="

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\nvm\current\node.exe" set "NODE=%APPDATA%\nvm\current\node.exe"
if not defined NODE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE=%USERPROFILE%\scoop\shims\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"

if not defined NODE goto nonode

echo [%DATE% %TIME%] node=%NODE% extdir=%EXTDIR% args=%*> "%LOG%"

title Python Challenge Camp
"%NODE%" "%EXTDIR%scripts\launch.js" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" goto onfail
exit /b %RC%

:onfail
echo.
echo   ------------------------------------------------------------
echo   Launch failed. Diagnostic log:
echo   %LOG%
echo   ------------------------------------------------------------
echo.
type "%LOG%"
echo.
pause
exit /b %RC%

:nonode
echo.
echo   [ERROR] Node.js not found.
echo.
echo   This launcher needs Node.js 18 or newer.
echo   Download the LTS build from: https://nodejs.org/
echo.
echo   After installing, close this window and double-click the
echo   shortcut again.
echo.
pause
exit /b 1
