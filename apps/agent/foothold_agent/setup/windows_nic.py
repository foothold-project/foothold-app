"""Fast read-only NIC revalidation through Windows IP Helper, after PS selection.

A fresh PowerShell process can exceed the shared runtime's 300ms watchdog.
GetAdaptersAddresses preserves that watchdog rather than widening it. Initial
physical/wired selection is still the strict PowerShell JSON path.
"""
import ctypes as C
from ipaddress import IPv4Address

U32 = C.c_uint32
P = C.c_void_p


class SocketAddress(C.Structure):
    _fields_ = [('pointer',P),('length',C.c_int)]


class Unicast(C.Structure):
    pass


Unicast._fields_ = [('length',U32),('flags',U32),('next',C.POINTER(Unicast)),
                   ('address',SocketAddress),('prefix_origin',C.c_int),('suffix_origin',C.c_int),
                   ('dad_state',C.c_int),('valid',U32),('preferred',U32),('lease',U32),('prefix',C.c_ubyte)]


class Gateway(C.Structure):
    pass


Gateway._fields_ = [('length',U32),('reserved',U32),('next',C.POINTER(Gateway)),('address',SocketAddress)]


class Adapter(C.Structure):
    pass


Adapter._fields_ = [('length',U32),('index',U32),('next',C.POINTER(Adapter)),('name',C.c_char_p),
                    ('unicast',C.POINTER(Unicast)),('anycast',P),('multicast',P),('dns',P),
                    ('dns_suffix',C.c_wchar_p),('description',C.c_wchar_p),('friendly',C.c_wchar_p),
                    ('mac',C.c_ubyte*8),('mac_length',U32),('flags',U32),('mtu',U32),
                    ('if_type',U32),('oper_status',C.c_int),('ipv6_index',U32),('zones',U32*16),
                    ('prefix',P),('tx_speed',C.c_uint64),('rx_speed',C.c_uint64),
                    ('wins',P),('gateway',C.POINTER(Gateway))]


def adapters(*, api=None):
    if api is None:
        api = C.WinDLL('iphlpapi',use_last_error=True).GetAdaptersAddresses
        api.argtypes = [U32,U32,P,P,C.POINTER(U32)]
        api.restype = U32
    size = U32(16384)
    for _ in range(3):
        if size.value > 1048576:
            raise ValueError('adapter metadata exceeds limit')
        buffer = C.create_string_buffer(size.value)
        # AF_UNSPEC, skip multicast/anycast/DNS; include gateways (both families).
        result = api(0,2|4|8|128,None,buffer,C.byref(size))
        if result == 111:  # ERROR_BUFFER_OVERFLOW
            continue
        if result != 0:
            raise OSError(result,'GetAdaptersAddresses failed')
        break
    else:
        raise OSError('adapter metadata changed repeatedly')
    rows = []
    current = C.cast(buffer,C.POINTER(Adapter))
    while current:
        row = current.contents
        if row.length < C.sizeof(Adapter) or row.mac_length > 8:
            raise ValueError('incomplete adapter metadata')
        addresses, gateways = [], []
        item = row.unicast
        while item:
            address = item.contents
            raw = C.string_at(address.address.pointer,address.address.length)
            if len(raw) >= 8 and int.from_bytes(raw[:2],'little') == 2:
                addresses.append((str(IPv4Address(raw[4:8])),int(address.prefix),int(address.dad_state)))
            item = address.next
        gateway = row.gateway
        while gateway:
            gateways.append(True)
            gateway = gateway.contents.next
        rows.append(dict(index=int(row.index),name=row.friendly,up=row.oper_status==1,
                         type=int(row.if_type),mac=':'.join(f'{b:02x}' for b in row.mac[:row.mac_length]),
                         addresses=addresses,gateways=gateways))
        current = row.next
    return rows


def matches(nic, *, query=adapters, routes=None):
    """Same identity and exact addresses, UP Ethernet, no IPv4/IPv6 gateway."""
    try:
        defaults = default_indexes() if routes is None else routes()
        if nic.index in defaults:
            return False
        rows = [r for r in query() if r['index']==nic.index and r['name']==nic.dds_name]
        if len(rows)!=1:
            return False
        row = rows[0]
        return (row['up'] is True and row['type']==6 and row['mac']==nic.mac
                and not row['gateways'] and bool(row['addresses'])
                and all(state==4 for _,_,state in row['addresses'])
                and tuple(sorted((a,p) for a,p,_ in row['addresses']))==nic.addresses)
    except (OSError, ValueError, KeyError, TypeError):
        return False


class InetAddress(C.Union):
    _fields_ = [('family',C.c_uint16),('raw',C.c_ubyte*28),('alignment',U32)]


class AddressPrefix(C.Structure):
    _fields_ = [('address',InetAddress),('prefix_length',C.c_ubyte)]


class Route(C.Structure):
    _fields_ = [('luid',C.c_uint64),('index',U32),('destination',AddressPrefix),
                ('next_hop',InetAddress),('site_prefix',C.c_ubyte),('valid',U32),
                ('preferred',U32),('metric',U32),('protocol',C.c_int),
                ('loopback',C.c_ubyte),('autoconfigure',C.c_ubyte),('publish',C.c_ubyte),
                ('immortal',C.c_ubyte),('age',U32),('origin',C.c_int)]


class RouteTable(C.Structure):
    _fields_ = [('count',U32),('rows',Route*1)]


def default_indexes(*, library=None):
    """Include on-link default routes, which adapter gateway lists can omit."""
    if library is None:
        library = C.WinDLL('iphlpapi',use_last_error=True)
        library.GetIpForwardTable2.argtypes = [C.c_uint16,C.POINTER(P)]
        library.GetIpForwardTable2.restype = U32
        library.FreeMibTable.argtypes = [P]
        library.FreeMibTable.restype = None
    pointer = P()
    result = library.GetIpForwardTable2(0,C.byref(pointer))
    if result != 0 or not pointer.value:
        raise OSError(result,'GetIpForwardTable2 failed')
    try:
        table = C.cast(pointer,C.POINTER(RouteTable)).contents
        if table.count > 65536:
            raise ValueError('route metadata exceeds limit')
        rows = C.cast(pointer.value+RouteTable.rows.offset,C.POINTER(Route))
        return {int(rows[i].index) for i in range(table.count) if rows[i].destination.prefix_length==0}
    finally:
        library.FreeMibTable(pointer)
