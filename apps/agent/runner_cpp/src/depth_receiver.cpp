#include "foothold/depth_receiver.hpp"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <system_error>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

using namespace std::chrono_literals;

namespace foothold {
namespace {
struct [[gnu::packed]] Packet {
    std::int64_t nanoseconds;
    Depth depths;
    float invalid;
};
static_assert(sizeof(Packet) == 8 + 3600 * sizeof(float) + sizeof(float));

int bind_depth(const std::filesystem::path& path) {
    const auto parent = path.parent_path();
    struct stat info{};
    if (!path.is_absolute() || lstat(parent.c_str(), &info) != 0 ||
        !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077) != 0)
        throw std::invalid_argument("depth socket needs an absolute path in a private, owned directory");
    sockaddr_un local{};
    local.sun_family = AF_UNIX;
    if (path.native().size() >= sizeof(local.sun_path))
        throw std::invalid_argument("depth socket path is too long");
    std::memcpy(local.sun_path, path.c_str(), path.native().size() + 1);
    const int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd == -1) throw std::system_error(errno, std::generic_category(), "depth socket");
    if (::bind(fd, reinterpret_cast<const sockaddr*>(&local), sizeof(local)) != 0) {
        const int error = errno;
        close(fd);
        throw std::system_error(error, std::generic_category(), "bind depth socket");
    }
    return fd;
}
}

DepthReceiver::DepthReceiver(std::filesystem::path path) : path_(std::move(path)), fd_(bind_depth(path_)) {}
DepthReceiver::~DepthReceiver() {
    close(fd_);
    unlink(path_.c_str());
}

const Depth* DepthReceiver::latest(Tick now, Tick* frame_stamp, float* invalid) {
    Packet packet;
    const auto size = recv(fd_, &packet, sizeof(packet), MSG_TRUNC);
    if (size == sizeof(packet) && packet.nanoseconds > 0) {
        const Tick stamp{std::chrono::nanoseconds(packet.nanoseconds)};
        const float share = packet.invalid;
        if (stamp > last_ && stamp <= now && now - stamp <= depth_freshness &&
            std::isfinite(share) && share >= 0 && share <= 1 &&
            std::all_of(packet.depths.begin(), packet.depths.end(),
                        [](float value) { return std::isfinite(value) && value >= 0 && value <= 1; })) {
            last_ = stamp;
            values_ = packet.depths;
            invalid_ = share;
        }
    }
    if (last_ == Tick{} || now - last_ > depth_freshness) return nullptr;
    if (frame_stamp) *frame_stamp = last_;
    if (invalid) *invalid = invalid_;
    return &values_;
}

}
