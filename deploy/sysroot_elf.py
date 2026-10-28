"""Inspect base-library names/ELF SONAME without executing payload code."""
import re
import struct

BASE_NAME = re.compile(r'^(?:libc\.so\.6(?:\.|$)|ld-linux|libstdc\+\+\.so\.6(?:\.|$)|libgcc_s|libpython3\.12|libssl|libcrypto|libsystemd)')


def forbidden(name):
    return bool(BASE_NAME.search(name))


def soname(data):
    if data[:4]!=b'\x7fELF' or len(data)<64 or data[4:6]!=b'\x02\x01':
        return None
    header=struct.unpack_from('<16sHHIQQQIHHHHHH',data)
    offset,entry_size,count=header[5],header[9],header[10]
    if count==0:return None  # Relocatable/debug objects have no loader SONAME.
    if entry_size<56 or count>8192 or offset+entry_size*count>len(data):
        raise ValueError('invalid ELF program headers')
    loads=[];dynamic=None
    for index in range(count):
        kind,flags,file_offset,virtual,physical,file_size,memory_size,alignment=struct.unpack_from('<IIQQQQQQ',data,offset+index*entry_size)
        if file_offset+file_size>len(data): raise ValueError('invalid ELF segment')
        if kind==1: loads.append((virtual,file_size,file_offset))
        if kind==2: dynamic=(file_offset,file_size)
    if dynamic is None:return None
    strings=string_size=name=None
    for position in range(dynamic[0],dynamic[0]+dynamic[1]-15,16):
        tag,value=struct.unpack_from('<qQ',data,position)
        if tag==0:break
        if tag==5:strings=value
        if tag==10:string_size=value
        if tag==14:name=value
    if name is None:return None
    if strings is None or string_size is None or name>=string_size: raise ValueError('invalid ELF SONAME table')
    for virtual,size,file_offset in loads:
        if virtual<=strings<virtual+size:
            start=file_offset+strings-virtual
            if start+string_size>len(data):raise ValueError('invalid ELF string segment')
            end=data.find(b'\0',start+name,start+string_size)
            if end<0:raise ValueError('unterminated ELF SONAME')
            return data[start+name:end].decode('ascii')
    raise ValueError('ELF SONAME string table unmapped')
