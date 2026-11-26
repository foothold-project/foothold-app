#include "foothold/app_socket.hpp"

#include <array>
#include <cerrno>
#include <stdexcept>
#include <system_error>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

namespace foothold {
namespace {
constexpr int max_per_tick = 64;
}

AppSocket::AppSocket(std::uint16_t port) {
    if (port != 0 && port < 1024) throw std::invalid_argument("app port must be 1024-65535 (0: any, tests only)");
    fd_ = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd_ == -1) throw std::system_error(errno, std::generic_category(), "app socket");
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(port);
    local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(fd_, reinterpret_cast<const sockaddr*>(&local), sizeof(local)) != 0) {
        const int error = errno;
        close(fd_);
        throw std::system_error(error, std::generic_category(), "bind app socket");
    }
}

AppSocket::~AppSocket() { close(fd_); }

std::uint16_t AppSocket::port() const {
    sockaddr_in local{};
    socklen_t size = sizeof(local);
    getsockname(fd_, reinterpret_cast<sockaddr*>(&local), &size);
    return ntohs(local.sin_port);
}

void AppSocket::poll(Tick now, AppInput& input) {
    std::array<char, app_packet_max + 1> buffer;
    for (int i = 0; i < max_per_tick; ++i) {
        sockaddr_in peer{};
        socklen_t size = sizeof(peer);
        const auto length = recvfrom(fd_, buffer.data(), buffer.size(), MSG_TRUNC,
                                     reinterpret_cast<sockaddr*>(&peer), &size);
        if (length < 0) return;  // EAGAIN (empty) or a transient error: try next tick
        if (size != sizeof(peer) || peer.sin_family != AF_INET || peer.sin_addr.s_addr != htonl(INADDR_LOOPBACK)) {
            input.drop(now, "peer");
            continue;
        }
        if (static_cast<std::size_t>(length) > app_packet_max) {
            input.drop(now, "too_large");
            continue;
        }
        input.receive(now, std::string_view(buffer.data(), static_cast<std::size_t>(length)), ntohs(peer.sin_port));
    }
}

void AppSocket::reply(const std::vector<AppAck>& acks) {
    for (const auto& ack : acks) {
        sockaddr_in peer{};
        peer.sin_family = AF_INET;
        peer.sin_port = htons(ack.peer);
        peer.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        const auto body = ack_json(ack);
        sendto(fd_, body.data(), body.size(), MSG_DONTWAIT, reinterpret_cast<const sockaddr*>(&peer), sizeof(peer));
    }
}

}
