#include "foothold/mode_worker.hpp"
#include "foothold/thread_schedule.hpp"

#include <atomic>
#include <cerrno>
#include <semaphore.h>
#include <stdexcept>
#include <system_error>
#include <thread>

namespace foothold {
namespace {
enum class State { idle, submitted, ready };
}

struct ModeWorker::Impl {
    Robot& robot;
    sem_t wake{};
    std::atomic<State> state{State::idle};
    std::atomic<bool> stop{false};
    ModeRequest request{};
    ModeResult result;
    std::thread thread;

    explicit Impl(Robot& robot) : robot(robot) {
        if (sem_init(&wake, 0, 0) != 0)
            throw std::system_error(errno, std::generic_category(), "mode worker sem_init");
        try {
            thread = std::thread([this] { run(); });
        } catch (...) {
            sem_destroy(&wake);
            throw;
        }
    }

    ~Impl() {
        stop.store(true, std::memory_order_release);
        sem_post(&wake);
        thread.join();
        sem_destroy(&wake);
    }

    void run() noexcept {
        name_thread("fh-mode");
        while (true) {
            int rc;
            do { rc = sem_wait(&wake); } while (rc < 0 && errno == EINTR);
            if (rc != 0 || stop.load(std::memory_order_acquire)) return;
            if (state.load(std::memory_order_acquire) != State::submitted) continue;
            const auto started = std::chrono::steady_clock::now();
            try {
                result = execute_mode(robot, request);
            } catch (...) {
                result = {};
                result.duration_ms = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - started).count();
            }
            state.store(State::ready, std::memory_order_release);
        }
    }
};

ModeWorker::ModeWorker(Robot& robot) : impl_(std::make_unique<Impl>(robot)) {}
ModeWorker::~ModeWorker() = default;

void ModeWorker::submit(ModeRequest request) {
    if (impl_->state.load(std::memory_order_acquire) != State::idle)
        throw std::logic_error("mode operation already pending");
    impl_->request = request;
    impl_->state.store(State::submitted, std::memory_order_release);
    sem_post(&impl_->wake);
}

std::optional<ModeResult> ModeWorker::poll() {
    if (impl_->state.load(std::memory_order_acquire) != State::ready) return std::nullopt;
    auto result = impl_->result;
    impl_->state.store(State::idle, std::memory_order_release);
    return result;
}

}
