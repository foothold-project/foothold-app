"""Inspect all archive paths first; merge bytes through no-follow directory fds.

No package code, scripts, tar extraction API, ldd or rootfs executable is run.
Absolute links describe the future RootDirectory, never a host lookup.
"""
import hashlib
import os
from pathlib import PurePosixPath
import re
import shutil
import stat
import tarfile

MAX_BYTES = 8 * 1024**3
MAX_MEMBERS = 500000
USRMERGE = {'bin':'usr/bin','sbin':'usr/sbin','lib':'usr/lib','lib64':'usr/lib64'}


class ArchiveError(ValueError):
    """Safe, package/member-specific diagnostics, including malformed names."""
    def __init__(self,source,item,error):
        self.source=str(source)
        self.member=item.name if item is not None else None
        self.target=item.linkname if item is not None and (item.issym() or item.islnk()) else None
        super().__init__(f'archive={ascii(self.source)} member={ascii(self.member)} '
                         f'target={ascii(self.target)}: {ascii(str(error))}')


def name(value, *, target=False):
    # systemd ships literal C-style escapes in unit basenames. On POSIX these
    # are ordinary bytes, never separators: preserve them, never unescape.
    if (not isinstance(value,str) or not value or len(value)>4096
            or re.search(r'\\(?!x[0-9a-fA-F]{2})',value)
            or any(ord(c)<32 or ord(c)==127 for c in value)):
        raise ValueError('invalid archive path')
    path=PurePosixPath(value)
    if not target and (path.is_absolute() or '..' in path.parts):
        raise ValueError('archive member escapes root')
    return str(path)


def resolve(value, links):
    pending=list(PurePosixPath(value).parts);out=[];count=0
    while pending:
        part=pending.pop(0)
        if part in ('','/','.'):continue
        if part=='..':
            if not out:raise ValueError('root-relative link escapes root')
            out.pop();continue
        out.append(part);key='/'.join(out)
        if key in links:
            count+=1
            if count>40:raise ValueError('cyclic archive link graph')
            target=PurePosixPath(links[key]);out.pop()
            if target.is_absolute():out=[]
            pending=list(target.parts)+pending
    return '/'.join(out)


def scan(stream,source='<archive>'):
    """Return bounded metadata and file digests; do not create any path."""
    rows=[];total=0;seen=set()
    item=None
    try:
        with tarfile.open(fileobj=stream,mode='r|*') as archive:
            for item in archive:
                path=name(item.name)
                if path=='.' and item.isdir():continue
                if path in seen:raise ValueError('duplicate member within archive')
                seen.add(path)
                if item.size<0:raise ValueError('negative archive member size')
                total+=item.size
                if total>MAX_BYTES or len(rows)>=MAX_MEMBERS:
                    raise ValueError('archive exceeds fixed envelope')
                if item.mode&~0o7777 or any('capability' in key.lower() for key in item.pax_headers):
                    raise ValueError('privileged archive metadata')
                row=dict(path=path,mode=0o555 if item.isdir() or item.mode&0o111 else 0o444)
                if item.isdir():row['type']='dir'
                elif item.issym():row.update(type='link',target=name(item.linkname,target=True))
                elif item.islnk():row.update(type='hardlink',target=name(item.linkname))
                elif item.isfile():
                    digest=hashlib.sha256();size=0
                    with archive.extractfile(item) as payload:
                        for chunk in iter(lambda:payload.read(1024*1024),b''):
                            size+=len(chunk);digest.update(chunk)
                    if size!=item.size:raise ValueError('short archive member')
                    row.update(type='file',sha256=digest.hexdigest(),size=size)
                else:raise ValueError('special archive node forbidden')
                rows.append(row)
    except (ValueError,tarfile.TarError,EOFError) as error:
        raise ArchiveError(source,item,error) from error
    return rows


def graph(packages):
    """Canonical merge plan, including usrmerge and cross-archive link parents."""
    raw={};links=dict(USRMERGE);count=0;size=0;path_bytes=0
    for rows in packages.values():
        for row in rows:
            count+=1;size+=row.get('size',0)
            path_bytes+=len(row['path'])+len(row.get('target',''))
            if count>MAX_MEMBERS or size>MAX_BYTES or path_bytes>64*1024**2:raise ValueError('rootfs exceeds fixed envelope')
            path=row['path'];previous=raw.get(path)
            if path in USRMERGE:
                if row['type']=='dir':continue
                if row['type']!='link' or row['target']!=USRMERGE[path]:
                    raise ValueError('unapproved usrmerge replacement')
            if previous and previous!=row:
                if previous['type']==row['type']=='dir':continue
                raise ValueError('unapproved archive collision')
            raw[path]=row
            if row['type']=='link':links[path]=row['target']
    # Add canonical spellings until nested aliases stop changing.
    for _ in range(40):
        additions={}
        for path,target in list(links.items()):
            parent,_,leaf=path.rpartition('/')
            canonical='/'.join(filter(None,(resolve(parent,links),leaf)))
            if canonical in links and links[canonical]!=target:
                raise ValueError('ambiguous canonical link')
            additions[canonical]=target
        old=len(links);links.update(additions)
        if len(links)==old:break
    else:raise ValueError('unstable archive link graph')
    for path in links:resolve(path,links)
    result={}
    for path,row in raw.items():
        if row['type']=='link':
            parent,_,leaf=path.rpartition('/')
            dest='/'.join(filter(None,(resolve(parent,links),leaf)))
        else:dest=resolve(path,links)
        if not dest:raise ValueError('archive replaces root')
        value={**row,'path':dest}
        if value['type']=='hardlink':value['target']=resolve(value['target'],links)
        previous=result.get(dest)
        if previous and previous!=value:
            if previous['type']==value['type']=='dir':continue
            raise ValueError('canonical archive collision')
        result[dest]=value
    for path,target in USRMERGE.items():result[path]=dict(path=path,type='link',target=target,mode=0o555)
    # Missing parents become ordinary directories, never links or files.
    for path in list(result):
        for parent in PurePosixPath(path).parents:
            if str(parent)=='.':continue
            value=result.setdefault(str(parent),dict(path=str(parent),type='dir',mode=0o555))
            if value['type']!='dir':raise ValueError('non-directory canonical parent')
    for row in result.values():
        if row['type']=='hardlink':
            target=result.get(row['target'])
            if not target or target['type']!='file':raise ValueError('hardlink target is not an ordinary file')
            row.update(type='file',sha256=target['sha256'],size=target['size'],mode=target['mode'])
    return links,result


def directory(root_fd, path, *, create=False):
    fd=os.dup(root_fd)
    try:
        for part in PurePosixPath(path).parts:
            if part in ('','.'):continue
            if part in ('..','/'):raise ValueError('invalid canonical directory')
            if create:
                try:os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError:pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except BaseException:
        os.close(fd);raise


def put(root_fd,path,source,expected):
    parent,_,leaf=path.rpartition('/');fd=directory(root_fd,parent,create=True)
    try:
        output=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
        digest=hashlib.sha256();size=0
        with os.fdopen(output,'wb') as target:
            for chunk in iter(lambda:source.read(1024*1024),b''):
                size+=len(chunk)
                if size>expected['size']:raise ValueError('changed archive member size')
                digest.update(chunk);target.write(chunk)
            target.flush();os.fsync(target.fileno())
            if size!=expected['size'] or digest.hexdigest()!=expected['sha256']:
                raise ValueError('changed archive member bytes')
            os.fchmod(target.fileno(),expected['mode'])
    finally:os.close(fd)


def merge(root,packages,streams):
    """Two-pass all-archive graph check; no link exists during any file write.

    streams(name) returns a context manager with a fresh tar byte stream.
    Root must be an empty private directory. Hardlinks become verified copies.
    """
    links,expected=graph(packages)
    if any(root.iterdir()):raise ValueError('merge root must be empty')
    root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    written=set();copies=[]
    try:
        for key,rows in packages.items():
            by_name={row['path']:row for row in rows}
            observed=[]
            with streams(key) as stream,tarfile.open(fileobj=stream,mode='r|*') as archive:
                for item in archive:
                    path=name(item.name)
                    if path=='.' and item.isdir():continue
                    row=by_name.get(path)
                    if row is None:raise ValueError('archive changed after inspection')
                    kind=('file' if item.isfile() else 'dir' if item.isdir() else
                          'link' if item.issym() else 'hardlink' if item.islnk() else 'special')
                    if (kind!=row['type'] or (kind in ('link','hardlink') and item.linkname!=row['target'])
                            or (kind=='file' and item.size!=row['size'])):
                        raise ValueError('archive member metadata changed after inspection')
                    observed.append(path)
                    if row['type'] not in ('file','hardlink'):continue
                    dest=resolve(path,links)
                    if dest in written:continue
                    if row['type']=='hardlink':copies.append((dest,resolve(row['target'],links)));continue
                    if not item.isfile():raise ValueError('archive member type changed')
                    with archive.extractfile(item) as source:put(root_fd,dest,source,expected[dest])
                    written.add(dest)
            if observed!=list(by_name):raise ValueError('archive member order/set changed')
        for dest,target in copies:
            if dest in written:continue
            parent,_,leaf=target.rpartition('/');fd=directory(root_fd,parent)
            try:
                source=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                with os.fdopen(source,'rb') as stream:put(root_fd,dest,stream,expected[dest])
            finally:os.close(fd)
            written.add(dest)
        for path,row in sorted(expected.items()):
            if row['type']=='dir':os.close(directory(root_fd,path,create=True))
        # Publish links only now. All byte writes are complete and no-follow.
        for path,row in sorted(expected.items()):
            if row['type']!='link':continue
            parent,_,leaf=path.rpartition('/');fd=directory(root_fd,parent)
            try:os.symlink(row['target'],leaf,dir_fd=fd)
            finally:os.close(fd)
        if written!={path for path,row in expected.items() if row['type']=='file'}:
            raise ValueError('incomplete archive merge')
    finally:os.close(root_fd)
    return expected
