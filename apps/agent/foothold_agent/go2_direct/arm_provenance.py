"""ARM local-build evidence, checked without importing/loading DDS or SDK.

This is a local build receipt, not a signature or a motion approval. Source
archive hashes are review inputs in code, never configurable through the env.
"""
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import sys

SOURCES = {
    'cyclonedds-c.tar.gz': {
        'version': '0.10.2', 'commit': '9995905bce6c4cf9f740d6438bbf7fcfd1c83dfd',
        'url': 'https://codeload.github.com/eclipse-cyclonedds/cyclonedds/tar.gz/0.10.2',
        'sha256': 'bc84e137e0c8a055b8cd97fbeafec94e36de1b0c2e88800896a82384fd867ae5'},
    'cyclonedds-0.10.2.tar.gz': {
        'version': '0.10.2', 'commit': '9cec1189a3d5a1407851dfe1f40899dd4a67f52d',
        'url': 'https://files.pythonhosted.org/packages/62/88/4b440f5916976234838989c3214222a5abc6fd48009a992c4dc22a86c04f/cyclonedds-0.10.2.tar.gz',
        'sha256': 'f834962eabbdcdf4e9cd75cf87222f3c5ef22d9cb9e7ed651d9a8710fe984a30'},
    'unitree-sdk2.tar.gz': {
        'version': '1.0.1', 'commit': '814556d15970dd2ecf1c9984e845ca02ab07e206',
        'url': 'https://codeload.github.com/unitreerobotics/unitree_sdk2_python/tar.gz/814556d15970dd2ecf1c9984e845ca02ab07e206',
        'sha256': '5224e774cf7a2ff784b957685225300f9e9627eb0b4fe5a76b8146a4fcbf4743'},
}
SOURCE_HASHES = {name: row['sha256'] for name, row in SOURCES.items()}
# Reject inherited bypasses even if set after package entry. NO_IMPORT_LIBS can
# otherwise make Python DDS appear installed while silently disabling loading.
OVERRIDES = ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH', 'LD_PRELOAD',
             'CYCLONEDDS_PYTHON_NO_IMPORT_LIBS', 'STANDALONE_WHEELS')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else _digest310(stream)


def _digest310(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(block)
    return value.hexdigest()


def aarch64_elf(path):
    # ELF64, little endian, current ELF version, EM_AARCH64 (183).
    with Path(path).open('rb') as stream:
        header = stream.read(20)
    return (len(header) == 20 and header[:7] == b'\x7fELF\x02\x01\x01'
            and int.from_bytes(header[18:20], 'little') == 183)


def inside_file(root, relative):
    if not isinstance(relative, str):
        raise ValueError('Jetson: 설치 파일 경로 형식이 잘못됐습니다.')
    path = root/relative
    if (Path(relative).is_absolute()
            or '..' in Path(relative).parts or path.resolve() != path
            or not path.is_file()):
        raise ValueError('Jetson: 설치 파일 경로가 바뀌었습니다. 새 묶음으로 다시 설치하세요.')
    return path


def installed_files(root):
    """Inventory the *actual* distributions, not a manifest-supplied subset."""
    result = set()
    for package in ('cyclonedds', 'unitree-sdk2py'):
        dist = metadata.distribution(package)
        files = dist.files
        if not files:
            raise ValueError('Jetson: 통신 프로그램 파일 목록이 없습니다. 다시 설치하세요.')
        package_dir = Path(dist.locate_file('cyclonedds' if package == 'cyclonedds' else 'unitree_sdk2py')).absolute()
        if package_dir.resolve() != package_dir or not package_dir.is_relative_to(root) or not package_dir.is_dir():
            raise ValueError('Jetson: 통신 프로그램 폴더 경로를 확인할 수 없습니다.')
        for path in package_dir.rglob('*'):
            if path.is_symlink():
                raise ValueError('Jetson: 통신 프로그램의 파일 연결이 바뀌었습니다. 다시 설치하세요.')
            if path.is_file() and (path.suffix == '.py' or '.so' in path.name):
                result.add(str(path.relative_to(root)))
        for item in files:
            path = Path(dist.locate_file(item)).absolute()
            if path.suffix == '.py' or '.so' in path.name:
                if not path.is_relative_to(root):
                    raise ValueError('Jetson: 사용자 폴더 밖의 통신 프로그램은 사용할 수 없습니다.')
                result.add(str(path.relative_to(root)))
    # CMake uses SONAME symlinks; hash the resolved, local regular file once.
    libraries = list((root/'dds/lib').glob('*.so*'))
    for path in libraries:
        resolved = path.resolve()
        if not resolved.is_relative_to(root/'dds/lib'):
            raise ValueError('Jetson: DDS 라이브러리 경로가 사용자 폴더를 벗어났습니다.')
        result.add(str(resolved.relative_to(root)))
    if ((root/'dds/lib/libddsc.so').resolve() != root/'dds/lib/libddsc.so.0.10.2'
            or not libraries or not any('/cyclonedds/_clayer.' in p for p in result)):
        raise ValueError('Jetson: DDS 라이브러리 또는 Python 연결 부품이 없습니다.')
    return result


def verify_receipt(root):
    manifest = inside_file(root, 'dds-build-manifest.json')
    if stat.S_IMODE(manifest.stat().st_mode) != 0o600 or manifest.stat().st_uid != os.getuid():
        raise ValueError('Jetson: DDS 빌드 기록의 소유자와 권한(0600)을 확인하세요.')
    receipt = json.loads(manifest.read_text())
    if (receipt['schema'] != 1 or receipt['sources'] != SOURCE_HASHES
            or receipt['machine'] != 'aarch64' or not receipt['built_at'] or not receipt['tools']):
        raise ValueError('Jetson: 승인된 DDS 원본 해시와 빌드 기록이 다릅니다. 다시 설치하세요.')
    for name, expected in SOURCE_HASHES.items():
        if digest(inside_file(root, 'bundle/sources/'+name)) != expected:
            raise ValueError('Jetson: DDS 원본 파일이 바뀌었습니다. 새 묶음으로 다시 설치하세요.')
    actual = installed_files(root)
    if set(receipt['files']) != actual:
        raise ValueError('Jetson: 통신 프로그램 파일이 빠지거나 추가됐습니다. 다시 설치하세요.')
    native = set()
    for name in actual:
        path = inside_file(root, name)
        record = receipt['files'][name]
        if digest(path) != record['sha256']:
            raise ValueError('Jetson: DDS 설치 파일 해시가 다릅니다. 새 묶음으로 다시 설치하세요.')
        if '.so' in path.name:
            if record['machine'] != 'aarch64' or not aarch64_elf(path):
                raise ValueError('Jetson: ARM용이 아닌 DDS 부품입니다. 이 Jetson에서 다시 빌드하세요.')
            native.add(name)
    if not native or not any(Path(p).name.startswith('libddsc.so') for p in native):
        raise ValueError('Jetson: 검증된 DDS 공유 라이브러리가 없습니다.')
    return receipt


def verify_import_origins():
    """Resolve top-level packages without importing SDK/DDS or loading ELF."""
    for distribution, module in (('cyclonedds', 'cyclonedds'),
                                 ('unitree-sdk2py', 'unitree_sdk2py')):
        package_dir = Path(metadata.distribution(distribution).locate_file(module)).absolute()
        try:
            spec = importlib.util.find_spec(module)
            origin = Path(spec.origin).resolve() if spec and spec.origin else None
        except (ImportError, ValueError, TypeError, OSError) as error:
            raise ValueError('Jetson: 불러올 통신 프로그램 경로를 확인할 수 없습니다. 새 터미널에서 다시 설치하세요.') from error
        if origin is None or not origin.is_relative_to(package_dir):
            raise ValueError('Jetson: 불러올 통신 프로그램이 검증한 폴더와 다릅니다. 다른 경로의 프로그램을 빼고 다시 확인하세요.')


def inspect_arm(pinned, inherited_override):
    packages = {}
    for name in pinned:
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    issues = []
    if platform.system() != 'Linux' or sys.version_info[:2] != (3, 10):
        issues.append('Jetson: Linux ARM용 Python 3.10으로 실행하세요.')
    if packages != pinned:
        issues.append('Jetson: 필요한 프로그램의 판이 다릅니다. 설치 묶음으로 다시 설치하세요.')
    if inherited_override or any(name in os.environ for name in OVERRIDES):
        issues.append('Jetson: DDS 환경 변수 덮어쓰기를 해제하고 새 터미널에서 실행하세요.')
    verified = False
    try:
        root = Path(sys.prefix).parent
        if (root != Path.home()/'foothold-robot' or root.resolve() != root
                or Path(sys.prefix) != root/'venv'):
            raise ValueError('Jetson: 전용 사용자 폴더의 venv로 실행하세요.')
        verify_receipt(root)
        verify_import_origins()
        verified = True
    except FileNotFoundError:
        issues.append('Jetson: DDS 빌드 기록이나 설치 파일이 없습니다. 설치를 끝낸 뒤 다시 확인하세요.')
    except ValueError as error:
        issues.append(str(error) if str(error).startswith('Jetson:') else
                      'Jetson: DDS 빌드 기록을 읽을 수 없습니다. 새 묶음으로 다시 설치하세요.')
    except (OSError, KeyError, TypeError, metadata.PackageNotFoundError):
        issues.append('Jetson: DDS 빌드 기록과 설치 파일을 확인할 수 없습니다. 다시 설치하세요.')
    return dict(installation_ready=not issues, issues=issues, packages=packages,
                sdk_commit_verified=verified, arm_manifest_verified=verified,
                sdk_imported=False, robot_connected=False, motion_enabled=False,
                field_nic_serial_approval_verified=False)
