"""Read-only ARM64 oracle for the user's 4.5.4 APK signing library.

Runs only inside Unicorn memory. It never loads this Android ELF into the host,
calls Qianji servers, or uses the TypeScript signer to generate expectations.
Install unicorn==2.1.4 in a disposable Python target directory, then set PYTHONPATH.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn import arm64_const as reg

LIBRARY_SHA256 = "441122805c78ab4b1a0435d42495c2beecfbde626baf9880e08187c40cf2f7e3"


class NativeOracle:
    def __init__(self, image, now_ms, package):
        if hashlib.sha256(image).hexdigest() != LIBRARY_SHA256:
            raise ValueError("This oracle is pinned to the inspected APK library")
        self.uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        for address, size in [(0, 0x20000), (0x100000, 0x1000),
                              (0x200000, 0x20000), (0x300000, 0x200000),
                              (0x500000, 0x10000), (0x600000, 0x1000)]:
            self.uc.mem_map(address, size)
        self.next_heap = 0x300000
        self.callbacks = {}
        self.next_callback = 0x500000
        self.now_ms = now_ms
        self.package = package
        phoff = struct.unpack_from("<Q", image, 32)[0]
        phsize, phcount = struct.unpack_from("<HH", image, 54)
        for i in range(phcount):
            kind, _, offset, address, _, size, _, _ = struct.unpack_from("<IIQQQQQQ", image, phoff + i * phsize)
            if kind == 1 and size:
                self.uc.mem_write(address, image[offset:offset + size])
        shoff = struct.unpack_from("<Q", image, 40)[0]
        shsize, shcount = struct.unpack_from("<HH", image, 58)
        sections = [struct.unpack_from("<IIQQQQIIQQ", image, shoff + i * shsize) for i in range(shcount)]
        for section in sections:
            if section[1] != 4:
                continue
            symbols = sections[section[6]]
            strings = sections[symbols[6]]
            for offset in range(section[4], section[4] + section[5], 24):
                target, info, addend = struct.unpack_from("<QQq", image, offset)
                kind, index = info & 0xFFFFFFFF, info >> 32
                if kind == 1027:
                    value = addend
                else:
                    name_at, _, _, section_index, address, _ = struct.unpack_from("<IBBHQQ", image, symbols[4] + index * 24)
                    end = image.index(b"\0", strings[4] + name_at)
                    name = image[strings[4] + name_at:end].decode()
                    value = address if section_index else self.callback(name)
                    if kind == 257:
                        value += addend
                    elif kind not in (1025, 1026):
                        raise ValueError(f"Unsupported relocation {kind}")
                self.uc.mem_write(target, struct.pack("<Q", value))
        vtable = self.alloc(bytes(0x600))
        for offset, name in [(0xF8, "jni_class"), (0x108, "jni_method"),
                             (0x110, "jni_call"), (0x538, "jni_new_string"),
                             (0x548, "jni_string_chars")]:
            self.uc.mem_write(vtable + offset, struct.pack("<Q", self.callback(name)))
        self.env = self.alloc(struct.pack("<Q", vtable))
        self.uc.reg_write(reg.UC_ARM64_REG_TPIDR_EL0, 0x100000)
        self.uc.reg_write(reg.UC_ARM64_REG_CPACR_EL1, 3 << 20)
        self.uc.hook_add(UC_HOOK_CODE, self.on_instruction)

    def callback(self, name):
        address = self.next_callback
        self.next_callback += 4
        self.callbacks[address] = name
        self.uc.mem_write(address, bytes.fromhex("c0035fd6"))
        return address

    def alloc(self, data):
        address = self.next_heap
        self.next_heap += (len(data) + 15) & ~15
        if self.next_heap >= 0x500000:
            raise ValueError("Native oracle allocation bound exceeded")
        self.uc.mem_write(address, data)
        return address

    def string(self, text):
        return self.alloc(text.encode("utf-8") + b"\0")

    def cstring(self, address):
        if not address:
            return b"(null)"
        data = bytearray()
        for i in range(8192):
            c = self.uc.mem_read(address + i, 1)[0]
            if c == 0:
                return bytes(data)
            data.append(c)
        raise ValueError("Native string bound exceeded")

    def args(self):
        return [self.uc.reg_read(getattr(reg, f"UC_ARM64_REG_X{i}")) for i in range(8)]

    def printf(self, format_at, va_at):
        stack, gr_top, _, gr_offset, _ = struct.unpack("<QQQii", self.uc.mem_read(va_at, 32))

        def value():
            nonlocal stack, gr_offset
            if gr_offset < 0:
                address = gr_top + gr_offset
                gr_offset += 8
            else:
                address = stack
                stack += 8
            return struct.unpack("<Q", self.uc.mem_read(address, 8))[0]

        def replace(match):
            spec = match.group()
            if spec == "%%":
                return "%"
            current = value()
            if spec == "%s":
                return self.cstring(current).decode("utf-8")
            if spec in ("%ld", "%d"):
                bits = 64 if spec == "%ld" else 32
                current &= (1 << bits) - 1
                return str(current if current < 1 << (bits - 1) else current - (1 << bits))
            if spec == "%02x":
                return f"{current & 0xFFFFFFFF:02x}"
            raise ValueError(f"Unimplemented libc format {spec}")

        return re.sub(r"%%|%s|%ld|%d|%02x", replace, self.cstring(format_at).decode()).encode()

    def on_instruction(self, _uc, address, _size, _data):
        name = self.callbacks.get(address)
        if name is None:
            return
        a = self.args()
        result = 0
        if name == "malloc":
            if a[0] > 100000:
                raise ValueError("Unexpected native allocation")
            result = self.alloc(bytes(max(1, a[0])))
        elif name == "memcpy":
            self.uc.mem_write(a[0], bytes(self.uc.mem_read(a[1], a[2])))
            result = a[0]
        elif name == "strlen":
            result = len(self.cstring(a[0]))
        elif name in ("strcpy", "strcat"):
            value = self.cstring(a[1])
            at = a[0] + (len(self.cstring(a[0])) if name == "strcat" else 0)
            self.uc.mem_write(at, value + b"\0")
            result = a[0]
        elif name == "clock_gettime":
            self.uc.mem_write(a[1], struct.pack("<qq", self.now_ms // 1000, self.now_ms % 1000 * 1000000 + 999999))
        elif name in ("vsnprintf", "__vsprintf_chk"):
            size, fmt, va = (a[1], a[2], a[3]) if name == "vsnprintf" else (a[2], a[3], a[4])
            value = self.printf(fmt, va)
            self.uc.mem_write(a[0], value[:max(0, size - 1)] + b"\0")
            result = len(value)
        elif name == "jni_class":
            result = 0x101
        elif name == "jni_method":
            method = self.cstring(a[2])
            result = {b"getPackageManager": 0x201, b"getPackageName": 0x202}[method]
        elif name == "jni_call":
            result = 0x301 if a[2] == 0x201 else self.string(self.package)
        elif name == "jni_string_chars":
            result = a[1]
        elif name == "jni_new_string":
            result = self.alloc(self.cstring(a[1]) + b"\0")
        elif name in ("exit", "__stack_chk_fail"):
            raise ValueError(f"Native execution rejected: {name}")
        elif name not in ("__cxa_finalize", "__cxa_atexit", "__register_atfork"):
            raise ValueError(f"Unimplemented import: {name}")
        self.uc.reg_write(reg.UC_ARM64_REG_X0, result)
        self.uc.reg_write(reg.UC_ARM64_REG_PC, self.uc.reg_read(reg.UC_ARM64_REG_LR))

    def invoke(self, address, *args):
        self.uc.reg_write(reg.UC_ARM64_REG_SP, 0x21F000)
        self.uc.reg_write(reg.UC_ARM64_REG_LR, 0x600000)
        for i, value in enumerate(args):
            self.uc.reg_write(getattr(reg, f"UC_ARM64_REG_X{i}"), value)
        self.uc.emu_start(address, 0x600000, count=2000000)
        if self.uc.reg_read(reg.UC_ARM64_REG_PC) != 0x600000:
            raise ValueError("Native instruction bound exceeded")
        return self.uc.reg_read(reg.UC_ARM64_REG_X0)


def generate(image):
    cases = [(1792000000123, "account", "login", 1234),
             (1792000000123, "syncv2", "pull", 1234),
             (1792000000999, "tag", "syncall", 1234),
             (1700000000000, "asset", "submit", 1234),
             (1792000000123, "account", "login", 1207)]
    vectors = []
    for ms, ctrl, act, version in cases:
        oracle = NativeOracle(image, ms, "com.mutangtech.qianji")
        assert oracle.invoke(0x1FC0) == ms
        # Test the APK's actual MD5 implementation against a standard-library oracle.
        for value in ("", "abc", "x" * 100):
            ptr = oracle.invoke(0x2130, oracle.env, oracle.string(""), oracle.string(value))
            assert oracle.cstring(ptr).decode() == hashlib.md5(value.encode()).hexdigest()
        ptr = oracle.invoke(0x26BC, oracle.env, 0, 0x401, oracle.string(ctrl), oracle.string(act), version)
        reqid = oracle.cstring(ptr).decode()
        ptr = oracle.invoke(0x28A4, oracle.env, 0, oracle.string(reqid))
        enc = oracle.cstring(ptr).decode()
        tok = hashlib.md5((reqid + "1172020" + ctrl + enc + act).encode()).hexdigest()
        vectors.append({"nowMs": ms, "package": "com.mutangtech.qianji", "versionCode": version,
                        "ctrl": ctrl, "act": act, "reqidv2": reqid, "encodedReqid": enc, "tok": tok})
    return {"source": {"apk": "4.5.4/1234", "abi": "arm64-v8a", "librarySha256": LIBRARY_SHA256,
                       "oracle": "Unicorn 2.1.4 executes the APK native ARM64 instructions; only JNI context, libc and clock are controlled. Java outer MD5 uses hashlib."},
            "vectors": vectors}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("library", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = generate(args.library.read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(result['vectors'])} native oracle vectors")
