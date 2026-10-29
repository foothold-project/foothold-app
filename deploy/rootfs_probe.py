"""Run only inside the reviewed RootDirectory as its dedicated unprivileged UID.

Imports and CPU EGL rendering only; no ROS node, Gazebo, command or session.
The host controller owns the unit, validates its namespace and saves this result.
"""
import ctypes as c
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys


def egl_render():
    egl=c.CDLL('libEGL.so.1');gl=c.CDLL('libGL.so.1')
    def function(lib,name,result,args):
        value=getattr(lib,name);value.restype=result;value.argtypes=args;return value
    display=function(egl,'eglGetPlatformDisplay',c.c_void_p,[c.c_uint,c.c_void_p,c.POINTER(c.c_int)])(0x31DD,None,None)
    initialize=function(egl,'eglInitialize',c.c_uint,[c.c_void_p,c.POINTER(c.c_int),c.POINTER(c.c_int)])
    major,minor=c.c_int(),c.c_int()
    if not display or not initialize(display,c.byref(major),c.byref(minor)):raise ValueError('software EGL initialization failed')
    context=surface=None
    destroy_context=function(egl,'eglDestroyContext',c.c_uint,[c.c_void_p,c.c_void_p])
    destroy_surface=function(egl,'eglDestroySurface',c.c_uint,[c.c_void_p,c.c_void_p])
    terminate=function(egl,'eglTerminate',c.c_uint,[c.c_void_p])
    make=function(egl,'eglMakeCurrent',c.c_uint,[c.c_void_p,c.c_void_p,c.c_void_p,c.c_void_p])
    try:
        if not function(egl,'eglBindAPI',c.c_uint,[c.c_uint])(0x30A2):raise ValueError('OpenGL EGL unavailable')
        attributes=(c.c_int*13)(0x3033,1,0x3040,8,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3038)
        config=c.c_void_p();count=c.c_int()
        choose=function(egl,'eglChooseConfig',c.c_uint,[c.c_void_p,c.POINTER(c.c_int),c.POINTER(c.c_void_p),c.c_int,c.POINTER(c.c_int)])
        if not choose(display,attributes,c.byref(config),1,c.byref(count)) or count.value!=1:
            raise ValueError('RGBA pbuffer config unavailable')
        size=(c.c_int*5)(0x3057,2,0x3056,2,0x3038)
        surface=function(egl,'eglCreatePbufferSurface',c.c_void_p,[c.c_void_p,c.c_void_p,c.POINTER(c.c_int)])(display,config,size)
        flags=(c.c_int*7)(0x3098,3,0x30FB,3,0x30FD,1,0x3038)
        context=function(egl,'eglCreateContext',c.c_void_p,[c.c_void_p,c.c_void_p,c.c_void_p,c.POINTER(c.c_int)])(display,config,None,flags)
        if not context or not surface or not make(display,surface,surface,context):raise ValueError('software GL context unavailable')
        renderer=function(gl,'glGetString',c.c_char_p,[c.c_uint])(0x1F01)
        if not renderer or b'llvmpipe' not in renderer.lower():raise ValueError('renderer is not llvmpipe')
        function(gl,'glViewport',None,[c.c_int]*4)(0,0,2,2)
        function(gl,'glClearColor',None,[c.c_float]*4)(.25,.5,.75,1)
        function(gl,'glClear',None,[c.c_uint])(0x4000)
        function(gl,'glFinish',None,[])()
        pixel=(c.c_ubyte*4)()
        function(gl,'glReadPixels',None,[c.c_int]*4+[c.c_uint,c.c_uint,c.c_void_p])(0,0,1,1,0x1908,0x1401,pixel)
        if function(gl,'glGetError',c.c_uint,[])()!=0 or any(abs(a-b)>1 for a,b in zip(pixel,(64,128,191,255))):
            raise ValueError('software pixel render/readback failed')
        return dict(llvmpipe=True,egl_render_readback=True,egl_version=[major.value,minor.value])
    finally:
        make(display,None,None,None)
        if context:destroy_context(display,context)
        if surface:destroy_surface(display,surface)
        terminate(display)


def native_geometry():
    vendor=Path('/opt/foothold-sim/python-vendor')
    if 'trimesh' in sys.modules:raise ValueError('geometry vendor must be selected before import')
    sys.path.insert(0,str(vendor))
    module=importlib.import_module('trimesh')
    if module.__version__!='5.1.0' or not Path(module.__file__).is_relative_to(vendor):
        raise ValueError('native geometry version/origin unproven')


def dependencies():
    native_geometry()  # include the separate pinned vendor in dependency checking
    # pip is an exact DEB payload, never installed or executed on the host.
    wheels=list(Path('/usr/share/python-wheels').glob('pip-*.whl'))
    if len(wheels)!=1:raise ValueError('locked pip metadata checker unavailable')
    sys.path.insert(0,str(wheels[0]))
    from pip._internal.operations.check import create_package_set_from_installed,check_package_set
    package_set,parsing_error=create_package_set_from_installed()
    missing,conflicts=check_package_set(package_set)
    if parsing_error or missing or conflicts:raise ValueError('rootfs Python dependency closure incomplete')
    for module in ('fastapi','pydantic','sqlalchemy','alembic','psycopg','uvicorn','websockets',
                   'numpy','cv2','PIL.Image','yaml','rclpy','gz.transport13','gz.msgs10'):
        importlib.import_module(module)
    return True


def main():
    if os.geteuid()==0:raise ValueError('dedicated unprivileged probe UID required')
    identity=json.loads(Path('/foothold-runtime/identity.json').read_text())
    if identity['recipe_sha256']!=os.environ['FH_SIM_ROOTFS_LOCK']:raise ValueError('rootfs recipe binding differs')
    root=Path('/').stat()
    if (root.st_dev,root.st_ino)!=(int(os.environ['FH_SIM_EXPECT_ROOT_DEV']),int(os.environ['FH_SIM_EXPECT_ROOT_INO'])):
        raise ValueError('probe RootDirectory inode differs')
    profile=json.loads(Path('/foothold-runtime/child-profile.json').read_text())['env']
    if any(os.environ.get(k)!=v for k,v in profile.items() if k in ('GALLIUM_DRIVER','LIBGL_ALWAYS_SOFTWARE','__EGL_VENDOR_LIBRARY_DIRS')):
        raise ValueError('software-render environment not pinned')
    if Path('/dev/dri').exists() or any(Path('/dev').glob('nvidia*')):raise ValueError('GPU device visible in rootfs')
    result=egl_render();result['python_closure']=dependencies();result['root_attested']=True
    for key,expected in (('PLUGIN','cf8365adce9108fff7e6541b8f109756b48475afddb7bca42df37f42f9877a70'),
                         ('POLICY','a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8')):
        path=Path(os.environ['FH_SIM_PROBE_'+key])
        if not path.is_relative_to('/opt/foothold-sim/assets/source') or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise ValueError('sealed native asset mismatch')
        if key=='PLUGIN':c.CDLL(str(path))
        else:
            import numpy as np
            with np.load(path,allow_pickle=False) as policy:
                if not policy.files:raise ValueError('policy archive empty')
                policy[policy.files[0]]
    result.update(schema=1,recipe_sha256=identity['recipe_sha256'],manifest_sha256=identity['manifest_sha256'],native_abi=True)
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Rootfs EGL/ABI probe refused; retain setup latch and escalate') from None
