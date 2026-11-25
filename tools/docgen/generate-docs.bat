@echo off
setlocal
rem Scan changed sources, generate pages, run the gates, then (unless --dry-run)
rem commit, push and open a PR. Needs start-model.bat running first.
rem Any argument is passed through: --check, --dry-run, --bootstrap.

set "ROOT=%~dp0..\.."
pushd "%ROOT%" || (
	echo ERROR: cannot enter "%ROOT%"
	exit /b 1
)

set "PY=%ROOT%\tools\docgen\.venv\Scripts\python.exe"
if not exist "%PY%" (
	echo ERROR: python environment missing: "%PY%"
	echo Create it first:
	echo     cd tools\docgen
	echo     python -m venv .venv
	echo     .venv\Scripts\python -m pip install -e .
	popd
	exit /b 1
)

set "BASE_URL=%QI_DOCGEN_LLM_BASE_URL%"
if not defined BASE_URL set "BASE_URL=http://127.0.0.1:8081/v1"
echo Repo : %CD%
echo Model: %BASE_URL%
echo.

"%PY%" tools\docgen\run.py %*
set "RC=%ERRORLEVEL%"

popd
if not "%RC%"=="0" (
	echo.
	echo run.py exited with %RC%
)
exit /b %RC%
