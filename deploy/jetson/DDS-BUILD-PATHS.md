# 차단 항목: CycloneDDS 0.10.2 ARM64 바이너리 공급

준비 PC의 CPython 3.10/`manylinux2014_aarch64` binary-only 다운로드는
`cyclonedds==0.10.2`에서 `No matching distribution`으로 멈췄다.
agent와 고정 SDK의 pure wheel만 만들어졌고 묶음은 **INCOMPLETE**다.
버전을 임의로 올리거나 부분 묶음을 설치하지 않는다. ARM64 wheel·libddsc 공급은
아래 환경을 준비한 뒤 별도로 수행할 차단 항목이다.

먼저 Orin 기본 이미지에 이미 설치된 것이 있는지 대상 Python으로
`python3 deploy/jetson/preflight.py`를 실행한다. SDK를 import하지 않고 배포판
`cyclonedds`, `unitree-sdk2py` 등의 버전, Python/`python_abi`, ARM64/libc/L4T,
설치 ELF의 NEEDED·bundled `.so`·외부 soname 해석을 보고한다. 기존 venv가 있으면
그 Python으로도 확인한다. 패키지 버전만 맞다고 소스 커밋/실제 DDS가 검증된 것은 아니다.

아래는 **미래에 별도 승인된 ARM64 빌드 환경/Orin에서만 수행할 절차**다.
이번 준비 PC에서는 apt/pip 설치·native 빌드·sudo·Orin 접촉을 실행하지 않았다.
시스템 Python을 교체하지 않으며, agent용 전용 Python ≥3.10과 그 판의 개발 헤더가
준비되지 않았다면 여기서 중단한다. JetPack 판만 보고 Python ABI를 추측하지 않는다.

## 길 A — 현장에 가기 전 Orin을 한 번 인터넷에 연결

별도 설치 승인을 받은 대상 Orin에서만 빌드 도구를 준비한다. 예시는 대상 Python이
3.10인 이미지용이다. 다른 판의 `python3.10-dev`를 그대로 설치하면 안 된다.

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential cmake git python3.10-dev python3.10-venv
```

사용자 전용 빌드 디렉터리에서 소스를 고정한다. 아래 커밋은 각각 공식 0.10.2 태그가
가리키는 C runtime과 Python binding이다. 다른 버전·태그 이동을 자동 수용하지 않는다.

```sh
git clone https://github.com/eclipse-cyclonedds/cyclonedds.git dds-core
git -C dds-core checkout --detach 9995905bce6c4cf9f740d6438bbf7fcfd1c83dfd
cmake -S dds-core -B dds-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DENABLE_SHM=OFF
cmake --build dds-build --parallel 2
sudo cmake --install dds-build
sudo ldconfig
git clone https://github.com/eclipse-cyclonedds/cyclonedds-python.git dds-python
git -C dds-python checkout --detach 9cec1189a3d5a1407851dfe1f40899dd4a67f52d
python3.10 -m venv ./dds-build-venv
./dds-build-venv/bin/python -m pip install setuptools wheel
CYCLONEDDS_HOME=/usr/local ./dds-build-venv/bin/python -m pip wheel --no-deps --no-build-isolation --wheel-dir ./dds-wheels ./dds-python
```

이는 빌드/설치만 하며 DDS participant를 만들거나 SDK 예제를 실행하지 않는다.
생성 wheel이 ARM64/CPython 대상 ABI이고 버전이 0.10.2인지, 외부 `libddsc`·
`libcycloneddsidl`의 NEEDED와 soname/해시를 확인해 빌드 환경·소스 커밋과 함께 보관한다.
`/usr/local` 라이브러리 설치/교체도 별도 현장 승인·기존 파일 보존/복구 계획이 필요하다.
runtime 셸에는 `CYCLONEDDS_HOME`/`LD_LIBRARY_PATH`를 넘기지 않는다. 표준 loader
경로로 해석되게 하고 preflight로 확인한다(실제 로딩/ABI 검증은 별도 승인 항목).

승인한 wheel을 준비 PC에 복사하면 아래 기존 묶음 스크립트에 정확한 해시와 함께
입력할 수 있다. `linux_aarch64` wheel은 그 Orin의 libc/ABI 전용이며 manylinux로
이름을 바꾸지 않는다. 묶음의 native ELF 점검이 성공해도 대상 ABI 대조는 남는다.

```sh
python3 deploy/jetson/build_wheelhouse.py --output ./runs/go2-complete-new --python-version 3.10 --cyclonedds-wheel "<검토한 ARM64 wheel>" --cyclonedds-sha256 "<검토한 SHA256>" --download
```

생성된 완성 wheelhouse로 새 agent venv를 설치한 뒤 그 Python으로 preflight를 다시 한다.
기본 이미지의 기존 SDK를 통째로 덮지 않는다. 실제 DDS 시작은 별도 실기 승인 후다.

## 길 B — ARM64 PC 또는 docker+qemu ARM64 빌드 환경

전용 ARM64 빌드 환경에서 같은 두 고정 소스·Python ABI로 위 순서의 wheel과 libddsc를
만든다. manylinux2014 호환 결과가 필요하면 그 ARM64 manylinux 빌드 환경 안에서
컴파일하고 auditwheel로 외부 라이브러리 포함/GLIBC symbol 요구를 검사·repair한다.
최신 Ubuntu에서 빌드한 결과를 manylinux2014로 단순 재명명하지 않는다.

```sh
auditwheel show ./dds-wheels/cyclonedds-0.10.2-*.whl
auditwheel repair --plat manylinux2014_aarch64 --wheel-dir ./reviewed-wheels ./dds-wheels/cyclonedds-0.10.2-*.whl
```

이 단계는 ARM64 build 환경의 호환성·auditwheel/patchelf·빌드 도구를 이미 준비한 뒤에만
실행한다. GLIBC symbol 요구가 맞지 않으면 중단하고 맞는 빌드 이미지에서 다시 만든다.
검토한 결과는 같은 `build_wheelhouse.py --cyclonedds-wheel ... --cyclonedds-sha256 ...`
입력으로 사용한다. wheel에 libddsc가 포함되었는지 또는 외부 `.so` 설치가 필요한지
PROVENANCE의 ELF NEEDED와 대상 preflight를 함께 대조한다.

현재 준비 PC에는 ARM64 compiler/docker/qemu/binfmt 환경이 없고 설치도 금지되어 있어
이 길은 실행하지 않았다. 현장 담당자에게 **완성 묶음이 있는 것처럼 인계하지 않는다**.
