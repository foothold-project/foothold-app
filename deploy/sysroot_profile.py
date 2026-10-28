"""Generate private relocation wrappers; original DEB members stay unchanged."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess

KEYS = frozenset(('PATH','LD_LIBRARY_PATH','PYTHONPATH','AMENT_PREFIX_PATH','CMAKE_PREFIX_PATH',
    'GZ_SIM_RESOURCE_PATH','GZ_SIM_SYSTEM_PLUGIN_PATH','GZ_GUI_PLUGIN_PATH','GZ_CONFIG_PATH',
    'GZ_RENDERING_ENGINE_PATH','GZ_RENDERING_RESOURCE_PATH','__EGL_VENDOR_LIBRARY_DIRS',
    'LIBGL_DRIVERS_PATH','LIBGL_ALWAYS_SOFTWARE','GALLIUM_DRIVER','MESA_LOADER_DRIVER_OVERRIDE',
    'EGL_PLATFORM','MESA_SHADER_CACHE_DISABLE','LP_NUM_THREADS','QT_QPA_PLATFORM','RUBYLIB','GEM_PATH'))


def generate(stage, final, lock_sha):
    runtime = stage/'foothold-runtime'
    runtime.mkdir(exist_ok=False)
    for name in ('bin','lib','gz-config','egl_vendor.d'):
        (runtime/name).mkdir()
    ros = stage/'opt/ros/jazzy'
    if not ros.is_dir(): raise ValueError('private ROS prefix missing')
    prefixes = [ros] + sorted(path for path in (ros/'opt').glob('*') if path.is_dir())
    def published(path): return str(final/path.relative_to(stage))
    def existing(paths): return [path for path in paths if path.is_dir()]
    libdirs = existing([stage/'usr/lib/x86_64-linux-gnu',stage/'usr/lib']+
                      [path/'lib' for path in prefixes]+[path/'lib/x86_64-linux-gnu' for path in prefixes])
    # Explicit private aliases replace update-alternatives (no maintainer scripts).
    for path in sorted(stage.rglob('*.so*')):
        if path.is_symlink() or not path.is_file() or path.parent in libdirs:
            continue
        with path.open('rb') as stream:
            if stream.read(4)!=b'\x7fELF': continue
        output = subprocess.run(['/usr/bin/readelf','-d',str(path)],check=True,capture_output=True,text=True).stdout
        match = re.search(r'\(SONAME\).*\[([^]/]+)\]',output)
        if not match: continue
        name = match[1]
        if any((directory/name).exists() for directory in libdirs): continue
        target = runtime/'lib'/name
        if target.is_symlink():
            if target.readlink()!=Path(published(path)):
                raise ValueError('ambiguous private library alias')
        else:
            target.symlink_to(published(path))
    derived = []
    for source in sorted(ros.rglob('*.yaml')):
        if 'gz' not in source.relative_to(ros).parts: continue
        text = source.read_text()
        rewritten = text.replace('/opt/ros/jazzy/',published(ros)+'/')
        for prefix in ('/usr/lib/','/usr/share/'):
            rewritten = rewritten.replace(prefix,str(final)+prefix)
        name = '__'.join(source.relative_to(ros).parts)
        (runtime/'gz-config'/name).write_text(rewritten)
        derived.append(dict(source=str(source.relative_to(stage)),sha256=hashlib.sha256(source.read_bytes()).hexdigest(),output=name))
    mesa = stage/'usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'
    if not mesa.is_file() or not mesa.resolve().is_relative_to(stage):
        raise ValueError('private Mesa EGL library missing or external')
    (runtime/'egl_vendor.d/50_mesa.json').write_text(json.dumps({
        'file_format_version':'1.0.0','ICD':{'library_path':published(mesa)}})+'\n')
    bins = existing([path/'bin' for path in prefixes]+[stage/'usr/bin'])
    python = existing([ros/'lib/python3.12/site-packages',ros/'local/lib/python3.12/dist-packages',
                       stage/'usr/lib/python3/dist-packages'])
    resource = existing([path/'share' for path in prefixes])
    media = sorted({path for path in ros.rglob('*') if path.is_dir() and path.name in ('media','resources','gz-rendering8','gz-sim8')})
    resource += [path for path in media if path not in resource]
    engines = sorted({path.parent for path in ros.rglob('libgz-rendering8-ogre2.so*')})
    systems = sorted({path.parent for path in ros.rglob('libgz-sim8-*.so*')})
    env = dict(PATH=published(runtime/'bin')+':'+':'.join(map(published,bins))+':/usr/bin:/bin',
        LD_LIBRARY_PATH=published(runtime/'lib')+':'+':'.join(map(published,libdirs)),
        PYTHONPATH=':'.join(map(published,python)),AMENT_PREFIX_PATH=published(ros),CMAKE_PREFIX_PATH=published(ros),
        GZ_CONFIG_PATH=published(runtime/'gz-config'),GZ_SIM_RESOURCE_PATH=':'.join(map(published,resource)),
        GZ_SIM_SYSTEM_PLUGIN_PATH=':'.join(map(published,systems+libdirs)),GZ_RENDERING_ENGINE_PATH=':'.join(map(published,engines+libdirs)),
        GZ_RENDERING_RESOURCE_PATH=':'.join(map(published,resource)),
        __EGL_VENDOR_LIBRARY_DIRS=published(runtime/'egl_vendor.d'),
        LIBGL_DRIVERS_PATH=published(stage/'usr/lib/x86_64-linux-gnu/dri'),
        LIBGL_ALWAYS_SOFTWARE='true',GALLIUM_DRIVER='llvmpipe',MESA_LOADER_DRIVER_OVERRIDE='swrast',
        EGL_PLATFORM='surfaceless',MESA_SHADER_CACHE_DISABLE='true',LP_NUM_THREADS='2',QT_QPA_PLATFORM='offscreen')
    ruby = existing([stage/'usr/lib/ruby/3.2.0',stage/'usr/lib/ruby/vendor_ruby',stage/'usr/lib/ruby/site_ruby',
                     stage/'usr/lib/x86_64-linux-gnu/ruby/3.2.0'])
    if ruby: env['RUBYLIB']=':'.join(map(published,ruby))
    gems=existing([stage/'usr/share/rubygems-integration/all',stage/'usr/lib/ruby/gems/3.2.0'])
    if gems: env['GEM_PATH']=':'.join(map(published,gems))
    gz = ros/'opt/gz_tools_vendor/bin/gz'
    ruby_exe = stage/'usr/bin/ruby3.2'
    if not gz.is_file(): raise ValueError('private Gazebo CLI missing')
    interpreter = published(ruby_exe) if ruby_exe.is_file() else '/usr/bin/ruby'
    if not ruby_exe.is_file() and not Path(interpreter).is_file():
        raise ValueError('Ruby interpreter unavailable; do not install globally')
    wrapper = '#!/bin/bash\n'
    for key in ('LD_LIBRARY_PATH','GZ_CONFIG_PATH','GZ_SIM_SYSTEM_PLUGIN_PATH','GZ_RENDERING_ENGINE_PATH','GZ_RENDERING_RESOURCE_PATH'):
        wrapper += 'export '+key+'='+shlex.quote(env[key])+'"${'+key+':+:$'+key+'}"\n'
    wrapper += 'exec '+shlex.quote(interpreter)+' '+shlex.quote(published(gz))+' "$@"\n'
    (runtime/'bin/gz').write_text(wrapper)
    (runtime/'bin/gz').chmod(0o755)
    if not set(env)<=KEYS: raise ValueError('unapproved runtime environment field')
    profile = dict(schema=1,lock_sha256=lock_sha,env=env)
    (runtime/'profile.json').write_text(json.dumps(profile,sort_keys=True)+'\n')
    setup = '# Private child-only setup; never source in the control manager.\n'
    setup += ''.join('export '+key+'='+shlex.quote(value)+'\n' for key,value in sorted(env.items()))
    setup += 'export ROS_DISTRO=jazzy ROS_VERSION=2 ROS_PYTHON_VERSION=3\n'
    (runtime/'ros-setup.bash').write_text(setup)
    (runtime/'derived.json').write_text(json.dumps(derived,sort_keys=True)+'\n')
    return profile
