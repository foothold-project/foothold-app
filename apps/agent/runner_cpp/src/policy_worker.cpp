#include "foothold/policy_worker.hpp"
#include "foothold/thread_schedule.hpp"

#include <atomic>
#include <cerrno>
#include <semaphore.h>
#include <stdexcept>
#include <system_error>
#include <thread>

namespace foothold {
namespace {
enum class Task { idle, submitted, result, error };

class Wakeup {
public:
    Wakeup() {
        if (sem_init(&sem_, 0, 0) != 0)
            throw std::system_error(errno, std::generic_category(), "sem_init");
    }
    ~Wakeup() { sem_destroy(&sem_); }
    void post() { sem_post(&sem_); }
    bool wait() {
        int result;
        do { result = sem_wait(&sem_); } while (result < 0 && errno == EINTR);
        return result == 0;
    }
private:
    sem_t sem_{};
};
}

struct PolicyWorker::Impl {
    Policy& policy;
    Wakeup request, started;
    std::atomic<Task> task{Task::idle};
    std::atomic<bool> stop{false};
    bool fifo = false;
    Inputs inputs;
    Outputs outputs;
    std::thread worker;

    Impl(Policy& policy, int priority)
        : policy(policy), worker([this, priority] { run(priority); }) {
        started.wait();
    }
    ~Impl() {
        stop.store(true, std::memory_order_release);
        request.post();
        worker.join();
    }

    void run(int priority) noexcept {
        name_thread("fh-sensing");
        fifo = set_fifo(priority);
        started.post();
        while (request.wait() && !stop.load(std::memory_order_acquire)) {
            if (task.load(std::memory_order_acquire) != Task::submitted) continue;
            try {
                policy.infer(inputs, outputs);
                task.store(Task::result, std::memory_order_release);
            } catch (...) {
                task.store(Task::error, std::memory_order_release);
            }
        }
    }
};

PolicyWorker::PolicyWorker(Policy& policy, int priority)
    : impl_(std::make_unique<Impl>(policy, priority)) {}
PolicyWorker::~PolicyWorker() = default;
bool PolicyWorker::realtime() const { return impl_->fifo; }
pthread_t PolicyWorker::thread() const { return impl_->worker.native_handle(); }

void PolicyWorker::submit(const Inputs& inputs) {
    if (impl_->task.load(std::memory_order_acquire) != Task::idle)
        throw std::logic_error("inference already pending");
    impl_->inputs = inputs;
    impl_->task.store(Task::submitted, std::memory_order_release);
    impl_->request.post();
}

Inference PolicyWorker::poll(Outputs& outputs) {
    const auto state = impl_->task.load(std::memory_order_acquire);
    if (state != Task::result && state != Task::error) return Inference::pending;
    if (state == Task::result) outputs = impl_->outputs;
    impl_->task.store(Task::idle, std::memory_order_release);
    return state == Task::result ? Inference::ready : Inference::failed;
}

}
