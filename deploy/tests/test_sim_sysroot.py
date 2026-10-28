"""Offline fake metadata and synthetic DEBs; never system apt, ROS, GPU or unit start."""
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from deploy import sim_sysroot as root


def archive(entries):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as tar:
        for name,kind,target in entries:
            item=tarfile.TarInfo(name)
            if kind=='link': item.type=tarfile.SYMTYPE; item.linkname=target; tar.addfile(item)
            elif kind=='fifo': item.type=tarfile.FIFOTYPE; tar.addfile(item)
            else:
                data=b'synthetic payload'
                item.size=len(data)
                tar.addfile(item,io.BytesIO(data))
    output.seek(0)
    return output


class PrivateSysrootTests(unittest.TestCase):
    def row(self,name='safe',version='1.0-1'):
        return dict(name=name,version=version,sha256='a'*64,size=20,filename='pool/main/s/safe.deb')

    def test_only_missing_nonbase_packages_can_enter_sysroot(self):
        root.validate_downloads([self.row()],{}, {'safe':'1.0'})
        for name in ('libc6','libc-bin','libc6-dev','ld-linux-x86-64','libstdc++6','libgcc-s1',
                     'python3.12-minimal','libpython3.12-stdlib','systemd','libsystemd0','openssl','libssl3t64',
                     'libegl-nvidia0','libnvrtc13','glx-diversions'):
            with self.subTest(name=name),self.assertRaises(ValueError):
                root.validate_downloads([self.row(name)],{}, {})
        with self.assertRaises(ValueError):
            root.validate_downloads([self.row()],{'safe':('1.0-1','installed')},{})
        with self.assertRaises(ValueError):
            root.validate_downloads([],{'safe':('0.9-1','installed')},{'safe':'1.0'})
        root.validate_downloads([],{'safe':('1.0-1','installed')},{'safe':'1.0'})

    def test_resolution_must_never_change_host_packages(self):
        self.assertEqual(root.simulation_changes('Inst safe (1.0-1 Ubuntu)',{}),[('safe','1.0-1')])
        for text in ('Inst safe [0.9] (1.0-1 Ubuntu)','Remv safe [1.0]','Purg safe [1.0]',
                     'Inst libc6 (2.39-1 Ubuntu)','Inst libglx-nvidia0 (1.0 Ubuntu)'):
            with self.subTest(text=text),self.assertRaises(ValueError):
                root.simulation_changes(text,{})
        with self.assertRaises(ValueError):
            root.simulation_changes('Inst safe (1.0-1 Ubuntu)',{'safe':('1.0-1','installed')})

    def test_archive_escape_special_node_link_parent_and_collision_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)/'stage';destination.mkdir()
            for entries in ([('../victim','file','')],[('/usr/victim','file','')],
                            [('usr/escape','link','../../../victim')],[('usr/escape','link','/usr/victim')],
                            [('usr/fifo','fifo','')],[('usr/link','link','lib'),('usr/link/payload','file','')]):
                with self.subTest(entries=entries),self.assertRaises(ValueError):
                    root.validate_tar(archive(entries),destination)
            self.assertEqual(root.validate_tar(archive([('usr/data','file',''),('usr/link','link','data')]),destination),2)
            (destination/'usr').symlink_to(Path(folder))
            with self.assertRaises(ValueError):
                root.validate_tar(archive([('usr/data','file','')]),destination)

    def test_sandbox_only_private_rw_clean_environment_no_service_calls(self):
        writable=Path('/opt/foothold-sim/apt')
        with patch.object(root,'execute',return_value='synthetic') as command:
            root.sandbox(['/usr/bin/apt-get','download','safe=1.0'],writable,apt_config=writable/'apt.conf')
        args=command.call_args.args[0]
        for value in ('--property=ProtectSystem=strict','--property=NoNewPrivileges=yes',
                      '--property=ReadWritePaths='+str(writable),'/usr/bin/env','-i'):
            self.assertIn(value,args)
        self.assertNotIn('install',args)
        with self.assertRaises(ValueError):
            root.sandbox(['/usr/bin/true'],Path('/usr'))

    def test_synthetic_deb_extracts_only_inside_test_folder_no_maintainer_script(self):
        with tempfile.TemporaryDirectory() as folder:
            work=Path(folder);source=work/'source';control=source/'DEBIAN'
            control.mkdir(parents=True)
            (control/'control').write_text('Package: foothold-synthetic\nVersion: 1.0-1\nArchitecture: all\nMaintainer: Test <test@users.noreply.github.com>\nDescription: synthetic offline fixture\n')
            marker=work/'script-must-not-run'
            (control/'postinst').write_text('#!/bin/sh\ntouch '+str(marker)+'\n')
            (control/'postinst').chmod(0o755)
            payload=source/'usr/share/foothold-synthetic';payload.mkdir(parents=True)
            (payload/'data').write_text('synthetic payload')
            deb=work/'synthetic.deb'
            subprocess.run(['dpkg-deb','--build','--root-owner-group',str(source),str(deb)],check=True,capture_output=True)
            target=work/'target';target.mkdir()
            root.inspect_deb(deb,target)
            subprocess.run(['dpkg-deb','-x',str(deb),str(target)],check=True,capture_output=True)
            self.assertEqual((target/'usr/share/foothold-synthetic/data').read_text(),'synthetic payload')
            self.assertFalse(marker.exists())

    def test_manifest_detects_content_and_link_target_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder);(path/'file').write_text('before');(path/'link').symlink_to('file')
            before=root.tree_manifest(path)
            (path/'file').write_text('after')
            self.assertNotEqual(before,root.tree_manifest(path))
            (path/'file').write_text('before');(path/'link').unlink();(path/'link').symlink_to('other')
            self.assertNotEqual(before,root.tree_manifest(path))

    def test_generated_profile_relocates_only_private_copies_and_uses_mesa(self):
        from deploy.sysroot_profile import generate
        with tempfile.TemporaryDirectory() as folder:
            stage=Path(folder);final=Path('/opt/foothold-sim/sysroot' )/('a'*64)
            ros=stage/'opt/ros/jazzy'
            for path in (ros/'opt/gz_tools_vendor/bin',ros/'opt/gz_sim_vendor/share/gz',
                         stage/'usr/lib/x86_64-linux-gnu/dri',stage/'usr/bin'):
                path.mkdir(parents=True,exist_ok=True)
            (ros/'opt/gz_tools_vendor/bin/gz').write_text('synthetic Ruby CLI')
            (stage/'usr/bin/ruby3.2').write_text('synthetic interpreter')
            (stage/'usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0').write_text('synthetic Mesa')
            original=ros/'opt/gz_sim_vendor/share/gz/sim.yaml'
            original.write_text('library_path: /opt/ros/jazzy/opt/gz_sim_vendor/lib/libsim.so\n')
            before=original.read_bytes()
            profile=generate(stage,final,'a'*64)
            self.assertEqual(original.read_bytes(),before)
            self.assertEqual(profile['env']['GALLIUM_DRIVER'],'llvmpipe')
            vendor=json.loads((stage/'foothold-runtime/egl_vendor.d/50_mesa.json').read_text())
            self.assertTrue(vendor['ICD']['library_path'].startswith(str(final)))
            rewritten=next((stage/'foothold-runtime/gz-config').glob('*.yaml')).read_text()
            self.assertIn(str(final)+'/opt/ros/jazzy/',rewritten)
            self.assertTrue((stage/'foothold-runtime/bin/gz').stat().st_mode&0o100)

    def test_old_system_install_cli_is_disabled_before_any_external_action(self):
        import sys
        from deploy import install_sim_packages as legacy
        source=Path(legacy.__file__).read_text()
        with patch.object(sys,'argv',[legacy.__file__,'--install','/private/unused.json']), \
                patch.object(root.os,'geteuid',return_value=0), patch.object(root.subprocess,'run') as command, \
                patch.object(root.tempfile,'mkdtemp') as temporary:
            with self.assertRaises(SystemExit):
                exec(compile(source,legacy.__file__,'exec'),{'__name__':'__main__','__file__':legacy.__file__})
            command.assert_not_called()
            temporary.assert_not_called()


    def test_nested_link_contraction_cannot_escape_private_root(self):
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)
            entries=[('usr/short','link','..'),('escape','link','usr/short/../../outside')]
            with self.assertRaises(ValueError):
                root.validate_tar(archive(entries),destination)

    def test_publication_parent_overrides_private_umask(self):
        import os
        import stat
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            parent=Path(folder)/'sysroot'
            old=os.umask(0o077)
            try:
                with patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)):
                    root.publish_parent(parent)
            finally:os.umask(old)
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode),0o755)

    def test_ros_signing_key_must_have_one_pinned_primary(self):
        correct='pub::::::::::\nfpr:::::::::'+root.ROS_KEY_FINGERPRINT+':\nsub::::::::::\nfpr:::::::::'+'b'*40+':\n'
        root.validate_ros_key(correct)
        for text in (correct.replace(root.ROS_KEY_FINGERPRINT,'a'*40),correct+correct,''):
            with self.assertRaises(ValueError):root.validate_ros_key(text)

    def test_base_runtime_filenames_and_soname_aliases_refused(self):
        from deploy.sysroot_elf import forbidden,soname
        import struct
        for name in ('libc.so.6','ld-linux-x86-64.so.2','libstdc++.so.6','libgcc_s.so.1',
                     'libpython3.12.so.1.0','libssl.so.3','libcrypto.so.3','libsystemd.so.0'):
            self.assertTrue(forbidden(name))
            with tempfile.TemporaryDirectory() as folder,self.assertRaises(ValueError):
                root.validate_tar(archive([('usr/lib/'+name,'file','')]),Path(folder))
        # Synthetic ELF64 DSO: innocuous filename, forbidden DT_SONAME.
        identity=b'\x7fELF\x02\x01'+b'\0'*10
        object_head=struct.pack('<16sHHIQQQIHHHHHH',identity,1,62,1,0,0,0,0,64,0,0,0,0,0)
        self.assertIsNone(soname(object_head))
        head=struct.pack('<16sHHIQQQIHHHHHH',identity,3,62,1,0,64,0,0,64,56,2,0,0,0)
        strings=b'\0libc.so.6\0'
        size=64+112+64+len(strings)
        load=struct.pack('<IIQQQQQQ',1,4,0,0x400000,0,size,size,4096)
        dynamic=struct.pack('<IIQQQQQQ',2,4,176,0x400000+176,0,64,64,8)
        values=b''.join(struct.pack('<qQ',key,value) for key,value in ((5,0x400000+240),(10,len(strings)),(14,1),(0,0)))
        data=head+load+dynamic+values+strings
        self.assertEqual(soname(data),'libc.so.6')
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w') as tar:
            item=tarfile.TarInfo('usr/lib/innocent.so');item.size=len(data)
            tar.addfile(item,io.BytesIO(data))
        output.seek(0)
        with tempfile.TemporaryDirectory() as folder,self.assertRaises(ValueError):
            root.validate_tar(output,Path(folder))
