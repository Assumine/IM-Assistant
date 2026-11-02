"""Install the research module's pinned SDKs using its committed lockfile, without package scripts."""
import subprocess

from tools.native_baseline import ROOT, environment, provenance


def install():
    subprocess.run([str(ROOT / provenance()['runtime']['bun']), 'install', '--frozen-lockfile', '--ignore-scripts'],
                   cwd=ROOT / 'modules/research', env=environment('research-test'), check=True,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


if __name__ == '__main__':
    install()
