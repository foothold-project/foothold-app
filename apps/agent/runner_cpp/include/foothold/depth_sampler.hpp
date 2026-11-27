#pragma once

#include "foothold/depth_receiver.hpp"

#include <atomic>
#include <mutex>
#include <thread>

namespace foothold {

class DepthSampler {
public:
    explicit DepthSampler(const std::filesystem::path&);
    ~DepthSampler();
    const Depth* latest(Tick now, Tick* stamp = nullptr);

private:
    void receive();
    DepthReceiver receiver_;
    std::mutex mutex_;
    Tick received_{}, copied_{};
    Depth incoming_{}, snapshot_{};
    std::atomic<bool> stopping_{false};
    std::thread worker_;
};

}
