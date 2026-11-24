#include "foothold/depth_sampler.hpp"
#include "foothold/thread_schedule.hpp"

using namespace std::chrono_literals;

namespace foothold {

DepthSampler::DepthSampler(const std::filesystem::path& socket)
    : receiver_(socket), worker_([this] { receive(); }) {}

DepthSampler::~DepthSampler() {
    stopping_.store(true, std::memory_order_release);
    worker_.join();
}

void DepthSampler::receive() {
    name_thread("fh-depth");
    Tick previous{};
    while (!stopping_.load(std::memory_order_acquire)) {
        Tick stamp;
        const auto* frame = receiver_.latest(std::chrono::steady_clock::now(), &stamp);
        if (frame && stamp != previous) {
            std::lock_guard lock(mutex_);
            incoming_ = *frame;
            received_ = previous = stamp;
        }
        std::this_thread::sleep_for(5ms);
    }
}

const Depth* DepthSampler::latest(Tick now) {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (lock.owns_lock() && received_ != copied_) {
        snapshot_ = incoming_;
        copied_ = received_;
    }
    return copied_ != Tick{} && copied_ <= now && now - copied_ <= depth_freshness ? &snapshot_ : nullptr;
}

}
