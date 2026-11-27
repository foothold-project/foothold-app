#include "foothold/depth_receiver.hpp"

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

using namespace foothold;
using namespace std::chrono_literals;

namespace {
void require(bool pass, const char* message) {
    if (pass) return;
    std::cerr << message << '\n';
    std::exit(1);
}

struct [[gnu::packed]] Packet {
    std::int64_t stamp;
    Depth depth;
    float invalid;
};
}

int main() {
    auto temporary = std::filesystem::temp_directory_path() / "foothold-depth-XXXXXX";
    auto directory_name = temporary.string();
    require(mkdtemp(directory_name.data()), "create private socket directory");
    const auto path = std::filesystem::path(directory_name) / "depth.sock";
    {
        DepthReceiver receiver(path);
        const int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
        require(fd >= 0, "create sender socket");
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        require(path.native().size() < sizeof(address.sun_path), "test path too long");
        std::memcpy(address.sun_path, path.c_str(), path.native().size() + 1);
        const auto now = std::chrono::steady_clock::now();
        auto send = [&](Tick stamp, float value, std::size_t size = sizeof(Packet), float invalid = .125f) {
            Packet packet{};
            packet.invalid = invalid;
            packet.stamp = std::chrono::duration_cast<std::chrono::nanoseconds>(stamp.time_since_epoch()).count();
            packet.depth.fill(value);
            require(sendto(fd, &packet, size, 0, reinterpret_cast<const sockaddr*>(&address),
                           sizeof(address)) == static_cast<ssize_t>(size), "send test depth");
        };

        require(!receiver.latest(now), "empty depth slot");
        send(now - 1s, .5f);
        require(!receiver.latest(now), "stale first frame was accepted");
        send(now - 1ms, .5f, sizeof(Packet) - 1);
        require(!receiver.latest(now), "truncated frame was accepted");
        send(now - 1ms, 1.1f);
        require(!receiver.latest(now), "out of range frame was accepted");
        send(now - 1ms, .5f, sizeof(Packet), 1.5f);
        require(!receiver.latest(now), "out of range invalid share was accepted");
        send(now - 1ms, .5f, sizeof(Packet) - sizeof(float));
        require(!receiver.latest(now), "frame without invalid share was accepted");
        send(now - 1ms, .25f);
        float invalid = -1;
        require(receiver.latest(now, nullptr, &invalid) && receiver.latest(now)->front() == .25f, "valid frame missing");
        require(invalid == .125f, "invalid share not carried");
        send(now - 2ms, .75f);
        require(receiver.latest(now)->front() == .25f, "older frame replaced recent frame");
        require(!receiver.latest(now + 250ms), "expired frame was reused");
        close(fd);
    }
    require(!std::filesystem::exists(path), "socket was not removed");
    std::filesystem::remove(directory_name);
}
